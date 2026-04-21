## Why

The current UpCloud deployment is a single OpenTofu project (`envs/upcloud/cluster/`) that owns the K8s cluster, Traefik, cert-manager, AND per-env app workloads (today: prod, with commented-out staging). Staging and prod share a plan/apply loop — you cannot iterate on staging without touching prod state. Splitting into per-env projects decouples staging's deploy cadence from prod's (the primary driver) and unlocks CI-driven staging deploys that carry a freshly-built image digest straight into `tofu apply`.

## What Changes

- **BREAKING** directory layout: `envs/upcloud/` subdirectory is removed. Four sibling projects live directly under `envs/`: `persistence/`, `cluster/`, `prod/`, `staging/`.
- **BREAKING** state-key rename: cluster state moves from S3 key `upcloud` to `cluster`; `prod` and `staging` are new keys; `persistence` unchanged.
- **BREAKING** cluster project is env-agnostic: the `local.instances` map is removed, along with `module.app_instance` (`for_each`), `module.dns`, and the leaf-cert path inside `module.cert_manager`. Cluster owns only the K8s cluster, Traefik, cert-manager chart, and `letsencrypt-prod` ClusterIssuer.
- **BREAKING** cert-manager module refactor: drops the `certificate_requests` input and the `helm_release.cert_manager_extras` wrapper. The ClusterIssuer becomes a direct `kubernetes_manifest`. Leaf certificate emission + the acme-solver `NetworkPolicy` move into the `app-instance` module.
- **BREAKING** kubeconfig delivery: cluster outputs `cluster_id` (+ `lb_hostname`, `active_issuer_name`, `node_cidr`, baseline constants bundle). App projects re-fetch kubeconfig via their own `ephemeral "upcloud_kubernetes_cluster"` block, which preserves the current "creds never in state at rest" property but requires each app project to hold its own UpCloud token (scoped to K8s-read).
- Per-env OAuth apps: two GitHub OAuth Apps (one per env's callback URL); each app project reads generic `TF_VAR_oauth2_client_id` / `TF_VAR_oauth2_client_secret`.
- `node_cidr` literal moves from a duplicated env-level constant into `modules/kubernetes/upcloud` as an output — removes a latent staleness bug.
- Staging bucket lifecycle moves from cluster state into the staging project itself (created with the env, destroyed with the env).
- Staging CI: a new GHA workflow `.github/workflows/deploy-staging.yml` runs on push to `main` — builds + pushes `ghcr.io/stefanhoelzl/workflow-engine:main`, captures the image digest from `docker/build-push-action`, and runs `tofu apply envs/staging/ -var image_digest=<sha256:...>`. Prod deploys stay operator-driven via the existing `release` tag ritual.
- Image identity: prod stays pinned by tag (`:v2026.04.20`); staging is digest-pinned (`@sha256:...`). The `app-instance` module's `image_hash` annotation-trigger works for both (opaque string).
- Dynu DNS record ownership moves from cluster to each app project.
- Persistence project dir moves from `envs/upcloud/persistence/` to `envs/persistence/` (state key unchanged).
- CLAUDE.md Production section rewritten for the four-project layout + new per-project credential matrix.

## Capabilities

### New Capabilities

None — this change reshapes existing infrastructure specs; it does not introduce a net-new capability.

### Modified Capabilities

- `infrastructure`: wholesale reshape of the Production Stack sections — project layout, cluster composition, module ownership boundaries, state-key layout, kubeconfig delivery, staging bucket ownership, DNS ownership, and the `node_cidr` source-of-truth move. Several existing requirements are removed (`Staging bucket in cluster state`, `Multi-instance support via for_each`, `Persistence project path` at old path); many are rewritten; new requirements are added for the per-env project contract and cluster outputs.
- `ci-workflow`: adds a staging deploy workflow (build + push + digest capture + `tofu apply staging/`) as a new concern alongside today's PR validation.

## Impact

**Code / config:**

- `infrastructure/envs/upcloud/` — removed.
- `infrastructure/envs/cluster/`, `infrastructure/envs/prod/`, `infrastructure/envs/staging/` — new.
- `infrastructure/envs/persistence/` — moved from `envs/upcloud/persistence/`.
- `infrastructure/modules/kubernetes/upcloud/upcloud.tf` — add `node_cidr` local + output.
- `infrastructure/modules/cert-manager/cert-manager.tf` — drop `certificate_requests` variable, drop `helm_release.cert_manager_extras`, drop `kubernetes_network_policy_v1.acme_solver_ingress`, replace with direct `kubernetes_manifest` ClusterIssuer.
- `infrastructure/modules/app-instance/` — add `kubernetes_manifest.certificate` + `kubernetes_network_policy_v1.acme_solver_ingress` (taking `active_issuer_name` input); add `cert_request` output removal cleanup.
- `.github/workflows/deploy-staging.yml` — new.
- `CLAUDE.md` — Production section rewritten; new upgrade note appended.

**State backend (S3 `tofu-state` bucket):**

- New keys: `cluster`, `prod`, `staging`.
- Deleted key: `upcloud` (after post-migration verification).
- Unchanged key: `persistence`.

**External systems:**

- Dynu DNS: new CNAME `staging.workflow-engine.webredirect.org` pointing at the (new) Traefik LB hostname. Prod CNAME is recreated during migration.
- GitHub: one new OAuth App for staging (`staging.workflow-engine.webredirect.org/oauth2/callback`).
- UpCloud: scoped API tokens — prod gets a new K8s-read token; staging gets a K8s-read + Object Storage token.
- Let's Encrypt: two cert issuances during migration (prod re-issue, staging new). Well within the 50/week limit.

**Operational:**

- One-off migration downtime ~20-25 min (Reading A: destroy + rebuild the K8s cluster from zero; persistence bucket + data survive).
- Ongoing: operator runs `tofu apply envs/prod/` after bumping `image_tag` in `prod/terraform.tfvars`. Staging deploys automatically via GHA.
- Prod project now requires an UpCloud token (reversal of the "only cluster needs UpCloud token" property today) because the ephemeral block re-fetches kubeconfig.

**Documentation:**

- CLAUDE.md Production + Upgrade notes sections rewritten.
- SECURITY.md — re-check §5 for statements tied to "one cluster project" that may need language updates; the invariants themselves are app-code and unaffected.
