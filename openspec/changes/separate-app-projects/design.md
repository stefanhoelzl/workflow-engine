## Context

Today the UpCloud production deployment is one OpenTofu project at `infrastructure/envs/upcloud/cluster/` that owns everything: the K8s cluster, Traefik, cert-manager, and all app-instance resources driven by a `local.instances` map with `for_each`. A commented-out `staging` entry hints at the original intent of co-locating multiple envs in one project, but the real operational need (independent apply cadence so staging can roll frequently without touching prod state) was never satisfied. The persistence project (`envs/upcloud/persistence/`) is already separate and holds prod's S3 bucket under its own state key.

Constraints that shape this design:

- The cluster module (`modules/kubernetes/upcloud`) emits kubeconfig outputs (`host`, `cluster_ca_certificate`, `client_certificate`, `client_key`) as `ephemeral = true`. Ephemeral outputs are not stored in state, so they cannot be consumed across projects via `data "terraform_remote_state"`. This is intentional — the creds never sit in state at rest.
- UpCloud does not offer a describe-K8s-cluster data source that returns kubeconfig without instantiating an `ephemeral` block — so any consumer of kubeconfig must either (a) keep the current ephemeral-output pattern, or (b) declare its own ephemeral block.
- Let's Encrypt HTTP-01 solver pods are spawned by cert-manager in the namespace of the `Certificate` resource. A per-namespace `NetworkPolicy` allowing Traefik → solver:8089 must exist in that namespace.
- The `image_hash` input on `app-instance` is the only mechanism that drives pod rollouts; whatever string is passed must change when the image content changes.
- `172.24.1.0/24` is the node CIDR today; it's declared in `modules/kubernetes/upcloud` and duplicated verbatim in the env-level `baseline` call — a latent staleness bug.

## Goals / Non-Goals

**Goals:**

- Decouple staging's apply cadence from prod's. Each env has its own state file.
- Continuous staging deploys: GHA builds + pushes + captures digest + applies on every push to `main`.
- Keep today's security property that kubeconfig is never written to state at rest.
- Make the cluster project env-agnostic — adding a third env (e.g. review) is a copy-paste, zero cluster change.
- Single source of truth for `node_cidr`.

**Non-Goals:**

- Automating prod deploys through CI. Prod stays operator-driven via the existing `release` tag ritual.
- Changing the staging cost/topology (parity with prod except for its own bucket).
- Supporting preview/PR-ephemeral envs (designing for this would add complexity; the split makes it easier to add later).
- Zero-downtime migration. A ~20-25 min planned downtime is acceptable.

## Decisions

### D1. Four sibling projects under `envs/`, no `upcloud/` subdir

```
infrastructure/envs/
├── local/         (unchanged; kind-based dev env)
├── persistence/   (moved from envs/upcloud/persistence/)
├── cluster/       (was envs/upcloud/cluster/, minus app concerns)
├── prod/          (new)
└── staging/       (new)
```

**Alternative considered:** nested `envs/upcloud/{cluster,prod,staging}/`. Rejected — the `upcloud/` folder has no siblings in the new layout and adds a directory level without meaning. `local/` is the only non-upcloud env and already lives directly under `envs/`.

### D2. Cluster project is env-agnostic; apps own per-env resources

Cluster owns: K8s cluster, baseline for the `traefik` namespace, Traefik helm release, cert-manager chart + `letsencrypt-prod` ClusterIssuer (as a direct `kubernetes_manifest`), LB hostname lookup via `data "http"`.

Cluster outputs (all non-sensitive, persistent):

```hcl
output "cluster_id"         { value = module.cluster.cluster_id }
output "lb_hostname"        { value = local.traefik_lb_hostname }
output "active_issuer_name" { value = module.cert_manager.active_issuer_name }
output "node_cidr"          { value = module.cluster.node_cidr }
output "baseline" {
  value = {
    rfc1918_except             = module.baseline.rfc1918_except
    coredns_selector           = module.baseline.coredns_selector
    pod_security_context       = module.baseline.pod_security_context
    container_security_context = module.baseline.container_security_context
  }
}
```

Each app project owns: its own namespace + default-deny (via its own `baseline` call), its `kubernetes_manifest.certificate`, its acme-solver `NetworkPolicy`, the full `app_instance` module, the Dynu DNS record. Staging additionally owns its own S3 bucket via `modules/object-storage/upcloud`.

**Alternative considered:** keep the cluster project as the "parent" that still creates app namespaces upfront, with apps filling in workloads. Rejected — this couples cluster apply to every new env change and fights the primary driver of independent cadence.

### D3. Kubeconfig delivery — apps re-fetch via their own ephemeral block (Path 2)

Each app project declares:

```hcl
data "terraform_remote_state" "cluster" {
  backend = "s3"
  config  = { bucket = local.state_bucket, key = "cluster", ... }
}

ephemeral "upcloud_kubernetes_cluster" "this" {
  id = data.terraform_remote_state.cluster.outputs.cluster_id
}

provider "kubernetes" {
  host                   = ephemeral.upcloud_kubernetes_cluster.this.host
  cluster_ca_certificate = ephemeral.upcloud_kubernetes_cluster.this.cluster_ca_certificate
  client_certificate     = ephemeral.upcloud_kubernetes_cluster.this.client_certificate
  client_key             = ephemeral.upcloud_kubernetes_cluster.this.client_key
}
```

**Alternatives considered:**

- **Path 1 (un-ephemeralize cluster outputs).** Simpler for apps, no UpCloud token needed. Blocker: the provider likely does not expose kubeconfig via persistent resource attributes; the `ephemeral` block is the only path. Even if it were possible, this would regress the "no creds in state" property.
- **Path 3 (cluster provisions a ServiceAccount + token Secret for apps).** Preserves the no-UpCloud-token property but introduces a long-lived SA token stored in encrypted state, plus manual rotation burden and non-trivial RBAC.

Path 2 wins on preserving the existing "no creds in state at rest" property. Cost: each app project holds its own UpCloud token (scoped narrowly — K8s read for prod; K8s read + Object Storage for staging). This reverses the "prod doesn't need an UpCloud token" property today but the blast radius is small (read-scoped).

### D4. cert-manager keeps helm_release wrapper; app-instance delivers Certificate via routes-chart

The current `helm_release "cert_manager_extras"` wraps an inline chart whose values carry YAML objects (ClusterIssuer, selfsigned issuers, leaf certs) rendered by Helm. This sidesteps a hard constraint: `kubernetes_manifest` does OpenAPI discovery at **plan** time against the live cluster, so any CRD-backed resource (like `cert-manager.io/Certificate`) can't be planned until the CRD is installed. Helm resolves kinds at render time, not plan time, so it dodges the discovery check.

After this change, the helm_release wrapper pattern stays, but its responsibilities shrink. The cert-manager module's chart values render only **cluster-scoped issuers** (ACME `letsencrypt-prod`, or the selfsigned bootstrap → CA → CA-issuer chain for local). Leaf certs and the per-namespace acme-solver NetworkPolicy move to app-instance.

In `app-instance`, the leaf Certificate rides on the existing `routes-chart` helm_release (which already renders Traefik IngressRoute + Middleware CRDs). A new `templates/certificate.yaml` in that chart emits the Certificate when the caller passes both `tlsSecretName` and `certIssuerName` as values. The acme-solver NetworkPolicy is a **plain `kubernetes_network_policy_v1`** (core API resource, not a CRD, no discovery issue).

**Alternatives considered:**

- **Direct `kubernetes_manifest` for ClusterIssuer and Certificate.** Rejected: plan-time CRD discovery fails on first apply of any project that co-hosts the chart install and the CRD consumer — notably the local env, which keeps cert-manager and app_instance in one project.
- **Add `gavinbunney/kubectl` provider** (lazy CRD discovery). Rejected: adding a new provider for a constraint the existing helm_release pattern already handles is a net-negative complexity tradeoff.
- **Dual delivery path** (direct manifest in prod/staging where plan-time CRDs exist, helm wrapper in local). Rejected: two code paths for one concept is a maintenance trap.

### D5. `node_cidr` exposed as cluster module output; apps read via remote_state

`modules/kubernetes/upcloud/upcloud.tf` adds:

```hcl
locals {
  node_cidr = "172.24.1.0/24"
}

resource "upcloud_network" "this" {
  ip_network { address = local.node_cidr ...}
}

output "node_cidr" {
  value = local.node_cidr
}
```

The env-level `baseline` call becomes `node_cidr = module.cluster.node_cidr`. For apps (separate projects), `node_cidr` rides the cluster's `baseline` output bundle via remote_state.

Value stays at `172.24.1.0/24`. Not resizing — no IP-plan pressure, future node count capped ~10.

### D6. Migration via full destroy + rebuild (downtime ~20-25 min)

Phases:

1. **Code refactor** (no live changes): refactor modules, create new env dirs, git-mv persistence out of `upcloud/`, add staging CI workflow.
2. **Destroy old**: `tofu destroy` in `envs/upcloud/cluster/` — takes down K8s cluster, Traefik, cert-manager, prod app, DNS record. Persistence bucket + data survive (separate project).
3. **Delete old state**: remove `envs/upcloud/` dir; delete S3 object `tofu-state/upcloud`.
4. **Apply cluster from zero** in `envs/cluster/` — ~12-17 min (UpCloud cluster provisioning dominates).
5. **Apply prod** in `envs/prod/` — ~2-3 min to pod-ready + cert issued. Downtime ends.
6. **Apply staging** in `envs/staging/` — all-new; needs a bootstrap `image_digest` on first apply (either reuse prod's digest or run the GHA workflow once with `workflow_dispatch`).
7. **Verify + cleanup**: revert any pre-reduced Dynu TTL, update CLAUDE.md.

**Alternatives considered:**

- **State migration with `tofu state rm` + `tofu import`** to preserve the K8s cluster and avoid downtime. Rejected: far higher operational complexity, state-surgery on Helm-owned resources has edge cases (Helm ownership annotations conflict with `kubernetes_manifest` import), bootstrap ordering constraints. The downtime gain (3-6 min vs 20-25 min) is not worth the risk.
- **Targeted destroy** (`-target=module.app_instance`) to keep cluster alive. Rejected: `-target` on destroy has known graph-handling footguns, and the destroy-everything path also serves as a free disaster-recovery exercise (proves the stack bootstraps from zero).

**Pre-flight optimization:** reduce Dynu CNAME TTL from 300s to 60s ~24h before migration so client DNS caches recover faster after the LB hostname changes on cluster recreate.

### D7. Staging deploy via GHA on push to `main`, digest-pinned

On push to `main`:

1. `docker/build-push-action@v7` builds + pushes `ghcr.io/stefanhoelzl/workflow-engine:main`.
2. Action emits `digest` output (sha256 of the image index).
3. Workflow runs `tofu apply envs/staging/ -var image_digest=<digest>` with GHA secrets providing state passphrase, UpCloud token, Dynu key, OAuth creds, AWS state creds.

Prod stays operator-driven: the existing `release.yml` workflow pushes `:v2026.<date>` + `:latest`; operator bumps `image_tag` in `prod/terraform.tfvars` and runs `tofu apply envs/prod/` locally.

**Alternatives considered:**

- **ghcr.io registry lookup at plan time** (`data "http"` for a token + manifest to extract the digest). Rejected once we saw `docker/build-push-action@v7` already emits the digest — lookup adds a cache-miss risk (plan fails if ghcr.io is down) with no gain over feeding the digest directly from the build job.
- **CI deploys prod too.** Rejected as out-of-scope. Prod deploys remain operator-controlled.

### D8. Per-project OAuth apps; generic var names

Two GitHub OAuth Apps (prod + staging — callback URLs differ by subdomain). Each app project reads `TF_VAR_oauth2_client_id` / `TF_VAR_oauth2_client_secret`. The operator supplies the correct pair when applying that project.

**Alternative considered:** env-prefixed var names (`TF_VAR_prod_oauth2_client_id` etc.) so both pairs are available at all times. Rejected as over-engineering — generic names keep each project's tfvar surface clean.

### D9. Staging image tag `:main`, not `:latest` or `:sha-<sha>`

Staging's image tag is cosmetic (the digest is what tofu consumes). `:main` conveys the branch, matches reader intuition, and is a single moving tag (no registry-cleanup burden). Per-commit stable tags would be useful for audit but double ghcr.io storage; the digest already provides stable per-deploy identity in the tfstate.

## Risks / Trade-offs

- [Prod requires an UpCloud token now] → Mitigation: scope the token narrowly (K8s read only). The only operation that needs UpCloud API is the ephemeral block's describe-cluster call.
- [Migration downtime ~20-25 min] → Mitigation: schedule a low-traffic window; pre-reduce Dynu TTL 24h prior so client DNS caches refresh within 60s after the LB hostname changes; keep the old `envs/upcloud/` code on a rollback branch until verification passes.
- [UpCloud cluster provisioning fails mid-migration (quota/capacity)] → Mitigation: rollback branch contains the old project so operator can re-apply it to rebuild the cluster (with a new LB hostname, which requires DNS update anyway).
- [GHA staging deploy fails mid-apply leaves partial state] → Mitigation: use GHA `concurrency: tofu-staging, cancel-in-progress: false` to serialize runs; S3 lockfile provides a second safety net.
- [Bootstrap digest for first staging apply is unknown] → Mitigation: run the GHA workflow once with `workflow_dispatch` before the first `tofu apply`; use its digest output as the bootstrap value.
- [Let's Encrypt rate limit during migration] → Mitigation: migration issues 2 certs (prod recreate + staging first). Limit is 50/week/domain; zero practical risk.
- [Staging bucket contents lost if staging project is destroyed] → Mitigation: accepted by design — staging data is ephemeral. The bucket lifecycle is coupled to the staging env on purpose.
- [`active_issuer_name` as a remote_state string could become stale if cluster's issuer is renamed] → Mitigation: apps that read this output fail loudly (cert-manager rejects Certificate with unknown `issuerRef`). The failure mode is explicit, not silent.

## Migration Plan

See D6 for the phased sequence. Rollback strategy:

- **Before destroy** (Phase 1, code-only changes): `git revert` — no live changes were made.
- **After destroy, before cluster re-apply** (Phase 2 → 3): re-apply the old `envs/upcloud/cluster/` code from the rollback branch to bring back the cluster + app (LB hostname will differ — update Dynu CNAME manually). ~20 min recovery.
- **After cluster re-apply, before app apply** (Phase 4 → 5): apply the old app code against the new cluster. Requires writing a small bridge (old app_instance pointed at the new cluster's kubeconfig). Non-trivial; prefer to push through.
- **After prod is up** (Phase 5+): forward-fix any issue — no rollback needed.

## Open Questions

- None blocking. CLAUDE.md rewrite details can be resolved during implementation.
