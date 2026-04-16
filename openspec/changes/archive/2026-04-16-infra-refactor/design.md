## Context

The infrastructure code grew iteratively over ~10 changes in April 2026: local dev stack, then prod UpCloud, then cert-manager, then NetworkPolicy hardening, then security headers. Each change added modules and wiring without rethinking the overall layout. The result is a 538-line `workflow-engine.tf` that mixes four concerns, security defaults scattered across modules with gaps, and a module hierarchy that doesn't match the mental model of "what runs where."

The cluster currently runs all workloads in the `default` namespace. A staging app-instance alongside production is blocked by name collisions. The Traefik plugin is fetched via a fragile `data.external` bash+curl pipeline. The `image/registry/` module is a 19-line no-op shim.

## Goals / Non-Goals

**Goals:**
- Make the infrastructure code easy to understand cold — directory structure teaches the reader
- Centralize security defaults (PodSecurity, NetworkPolicy, securityContext) in one reviewable file
- Enable multi-instance deployment (prod + staging in the same cluster) via `for_each`
- Reduce code duplication (~180 lines of NP boilerplate, ~80 lines of oauth2 env vars)
- Close the pod securityContext gap (app, oauth2-proxy, s2 have none today)
- Decouple app routes from Traefik lifecycle (route edits shouldn't restart Traefik)
- Simplify plugin vendoring (remove bash/curl runtime dependency)

**Non-Goals:**
- Filesystem-backed persistence variant (app supports `PERSISTENCE_PATH` but infra doesn't wire it — defer until needed)
- ExternalDNS adoption (Dynu is not in ExternalDNS's provider list; stick with TF restapi)
- Bootstrap composition wrapper module (roots compose 4 modules directly; wrapper adds conditional plumbing for marginal reduction)
- State split per layer (one state per env is sufficient; only persistence retains its separate state)
- Workload factory module (3 pods don't justify the abstraction; individual resources with shared security locals are clearer)

## Decisions

### D1: Namespace-per-instance (not name-prefix, not YAGNI)

Each app-instance gets its own K8s namespace (`ns/prod`, `ns/staging`). Traefik moves to `ns/traefik`. `default` is left empty (except S2 in local env).

**Why not name-prefix?** Prefixing every resource name (`prod-workflow-engine`, `staging-workflow-engine`) is error-prone — one missed prefix causes a silent state collision. It also ripples into every label selector and NP rule. Namespace isolation is the Kubernetes-native answer.

**Why not YAGNI?** Staging deployment is near-term (not speculative). Designing for single-instance today and refactoring later costs more than paying the namespace-move cost once. The namespace move is already needed for security hygiene — workloads should not share `default` with infrastructure controllers.

**Alternatives considered:**
- Name-prefix in shared namespace: messier code, ripples into all NP selectors, collision risk
- Single-instance today (defer): costs a second refactor when staging arrives imminently

### D2: Individual resources with shared security locals (not a workload factory)

Each Deployment is a standalone `kubernetes_deployment_v1` resource (~35 lines each) referencing shared `local.pod_sc` and `local.container_sc` locals. No factory module, no `for_each` over a workloads map.

**Why not a factory?** Three pods don't justify an abstraction. The factory (100 lines of `dynamic` blocks + `type = any` untyped input) saves ~50 net lines but adds indirection: debugging requires tracing `for_each` keys, grep finds a generic `"this"` resource instead of a named one, and the first edge case (different probe paths, init container, PVC mount) forces expansion of the factory. The abstraction cost exceeds the duplication cost at this scale.

**Alternatives considered:**
- `modules/workload/` factory with `for_each`: elegant density at the definition site, but fragile factory becomes a mini Helm chart in HCL
- Shared module that creates Deployment + Service: "grep stops working" — too much indirection for 3 pods

### D3: Routes via co-located local Helm chart (not kubernetes_manifest, not extraObjects)

Each app-instance creates its own `helm_release` pointing at `modules/app-instance/routes-chart/` (a local chart like `cert-manager/extras-chart/`). IngressRoutes and Middlewares are Helm templates with `{{ .Values }}` interpolation.

**Why not `kubernetes_manifest`?** `kubernetes_manifest` requires the CRDs to be registered at *plan time*. On a fresh `tofu apply` that creates the cluster + installs Traefik + creates routes in one run, plan fails because Traefik CRDs don't exist yet. This breaks the hard requirement of single-apply-from-scratch.

**Why not keep Traefik `extraObjects`?** Route edits trigger Traefik Helm chart re-rendering and pod rolling restart. Multiple app-instances contributing to a single `extraObjects` list creates a coupling: every route change in any instance re-plans the shared Traefik release.

**Alternatives considered:**
- `kubernetes_manifest` resources: plan-time CRD dependency breaks single-apply
- Keep routes as `extraObjects` pass-through: couples all instances to one Traefik release lifecycle
- `gavinbunney/kubectl_manifest` provider: third-party, less maintained

### D4: Committed plugin tarball (not data.external fetch)

The Traefik inline-response plugin tarball (~200KB) is committed to `modules/traefik/plugin/plugin-<version>.tar.gz` and read via `filebase64()`. The ConfigMap is a 5-line resource.

**Why not keep `data.external`?** The current pipeline (bash + curl + base64 + cache + terraform_data + ignore_changes + state-capture) is 40+ lines of workaround code documented in 50+ lines of spec scenarios. It requires bash, curl, and base64 in PATH (breaks Windows dev), creates a `.plugin-cache/` directory, and has a "fresh clone re-fetch" failure class. Committing the file eliminates the entire class.

**Why not `data "http"`?** Emits an unconditional "response is not UTF-8" warning on binary bodies. Cosmetic but noisy on every plan.

**Alternatives considered:**
- `data.external` with bash (current): fragile, platform-dependent, complex state management
- `data "http"` with `response_body_base64`: works but emits warning on every plan

### D5: Profile-based NetworkPolicy factory

`modules/netpol/` takes a profile spec (`egress_internet`, `egress_dns`, `ingress_from_pods`, `ingress_from_cidrs`, `egress_to`) and creates one `kubernetes_network_policy_v1`. Shared constants (RFC1918 `except` list, CoreDNS selector, node CIDR) come from `modules/baseline/` outputs.

**Why a factory for NPs but not for Deployments?** NPs have a genuinely uniform shape: every NP is `pod_selector` + a list of `ingress`/`egress` rules. The variation is *what rules*, not *what structure*. The profile block reads as documentation ("this pod gets internet egress, DNS, and Traefik ingress on port 8080"). Deployments have heterogeneous structure (different env patterns, volumes, probes, init containers) that resists uniform expansion.

### D6: PodSecurity `restricted` with warn-then-enforce rollout

Phase 1 applies `pod-security.kubernetes.io/warn=restricted` on workload namespaces. Phase 2 adds securityContext to all pods and flips to `enforce`. Both phases are in one PR (two commits).

**Why warn first?** The `warn` label surfaces every non-compliant pod in `tofu apply` output without rejecting them. This is a free production dry-run that catches issues (Traefik chart defaults, cert-manager solver pods, s2 filesystem writes) before enforcement breaks anything.

### D7: Directory layout

```
infrastructure/
├─ envs/
│  ├─ local/                     # one apply, local backend
│  └─ upcloud/
│     ├─ persistence/            # own S3-remote state (long-lived bucket)
│     └─ cluster/                # own S3-remote state (cluster + apps)
├─ templates/                    # sign_in.html, error.html, error-5xx.html
└─ modules/
   ├─ baseline/                  # PSA labels, default-deny NP, securityContext locals
   ├─ netpol/                    # NP profile factory
   ├─ workload/                  # (NOT created — see D2)
   ├─ traefik/                   # Helm release + plugin.tf (committed tarball)
   ├─ cert-manager/              # unchanged
   ├─ kubernetes/{kind,upcloud}/ # unchanged contracts
   ├─ object-storage/{s2,upcloud}/ # renamed from s3/
   ├─ image/build/               # renamed from image/local/
   ├─ dns/dynu/                  # extracted from upcloud root
   └─ app-instance/              # flattened (was workflow-engine/ with nested sub-modules)
      ├─ workloads.tf            # app + oauth2 Deployments with shared security locals
      ├─ secrets.tf              # K8s Secrets + ConfigMaps
      ├─ oauth2-locals.tf        # oauth2 env map + secret key map
      ├─ netpol.tf               # two netpol factory calls
      ├─ routes.tf               # helm_release for routes-chart/
      ├─ routes-chart/           # local Helm chart (IngressRoutes + Middlewares)
      └─ outputs.tf              # cert_request, services
```

**Why `envs/` not `stacks/`?** `envs/` (or `environments/`) is the dominant convention in the Terraform/OpenTofu ecosystem. `stacks/` comes from Pulumi/CDK.

**Why persistence as sibling to cluster under upcloud/?** Both are under the same cloud provider but have separate state and separate lifecycles. Making "one directory = one state" literal at the filesystem level teaches the reader.

### D8: Env roots compose 4 modules directly (no bootstrap wrapper)

Each env root calls `modules/baseline`, `modules/traefik`, `modules/cert-manager`, and `modules/app-instance` directly. No `modules/cluster-bootstrap/` wrapper.

**Why no wrapper?** Env-specific variation (selfsigned vs ACME, S2 only in dev, LB annotations only in prod) would require conditional plumbing inside the wrapper. The wrapper becomes a "god module" whose inputs explode. Four module calls in a ~90-line root is readable enough.

### D9: Staging bucket in cluster state (not persistence state)

Staging's S3 bucket is created in `envs/upcloud/cluster/` (destroyed when staging instance is removed). Production's bucket stays in `envs/upcloud/persistence/` (survives cluster teardowns).

**Why separate lifecycle?** Production data is precious; staging data is disposable. Staging bucket should die with its instance — no reason to persist it independently.

### D10: Labels standardized on `app.kubernetes.io/name` + `app.kubernetes.io/instance`

All workloads use `app.kubernetes.io/name` (what service: `workflow-engine`, `oauth2-proxy`, `s2`, `traefik`) and `app.kubernetes.io/instance` (which instance: `prod`, `staging`, `s2`). Replaces the current mix of `app = "workflow-engine"` and `app.kubernetes.io/name = "traefik"`.

### D11: Dockerfile `USER 65532` (numeric)

PodSecurity admission cannot statically verify that `USER nonroot` maps to a non-root UID. Numeric UIDs are validated at admission time without image inspection. 65532 is the distroless "nonroot" UID.

## Risks / Trade-offs

**[R1] ~2-5 min production downtime during migration** → Acceptable for a solo-dev project. All K8s resources in `default` are destroyed and recreated in new namespaces. ACME cert re-issues in ~60s. Schedule during a maintenance window.

**[R2] PodSecurity `restricted` may reject pods we don't control** → The `warn` phase (Phase 1) surfaces incompatibilities before `enforce` (Phase 2). cert-manager v1.16+ solver pods are `restricted`-compliant. Traefik chart defaults need verification — explicit overrides in Helm values make us independent of chart defaults.

**[R3] S2 image may not run as UID 65532** → If `mojatter/s2-server:0.4.1` requires root, the pod will fail with `restricted` enforcement. Mitigation: mount emptyDir at `/data` and `/tmp`; if the image hardcodes root, either fork the image, find an alternative, or relax PSA on `default` namespace only (dev-only, not prod).

**[R4] Cross-namespace NPs are more verbose** → Traefik egress rules to app backends require `namespaceSelector` + `podSelector` (2 extra lines per rule). The netpol factory absorbs this verbosity; profile blocks remain readable.

**[R5] `moved {}` blocks limited to non-K8s resources** → Namespace changes are K8s-level identity changes; `moved {}` can't prevent destroy+recreate. Only the Dynu DNS `restapi_object` gets a `moved {}` block. Accept destroy+recreate for all K8s resources.

**[R6] `type = any` on netpol factory inputs** → The netpol factory uses typed object variables for its profile fields (not `any`), so misconfiguration is caught at plan time. This risk applies only if we had used a workload factory (D2 — rejected).

## Migration Plan

### Pre-migration (before merging PR)

1. Verify Traefik chart v39.0.7 container securityContext defaults: `helm show values traefik/traefik --version 39.0.7 | grep -A10 securityContext`
2. Verify cert-manager v1.16.2 solver pods pass restricted: check cert-manager release notes
3. Find s2-server data write path: `podman run --rm mojatter/s2-server:0.4.1 ls -la /`
4. Download and commit plugin tarball: `curl -L <url> -o modules/traefik/plugin/plugin-v0.1.2.tar.gz`

### Production cutover

Single PR, two commits:

**Phase 1 commit — reshape, no behavior change:**
- Move files into `envs/` layout
- Rename modules + `moved {}` block for Dynu DNS
- Create `modules/baseline/` with PSA `warn` label (observe only)
- Create `modules/netpol/` factory
- Flatten `modules/app-instance/`
- Standardize labels (`app.kubernetes.io/*`)
- oauth2 env vars refactored to dynamic maps
- Extract 5xx template to `templates/error-5xx.html`
- Commit plugin tarball, remove `data.external` pipeline
- Extract `modules/dns/dynu/`

**Phase 2 commit — behavior changes:**
- Add securityContext to app, oauth2-proxy, s2, Traefik init container
- Flip PSA label from `warn` to `enforce` on all workload namespaces
- Move workloads to per-instance namespaces (destroy+recreate)
- Create `routes-chart/` and per-instance `helm_release` for routes
- Add `for_each` over instances map
- Dockerfile `USER 65532`

### Cutover sequence

```
1. git pull on deploy machine
2. cd infrastructure/envs/upcloud/cluster && tofu init
   (same S3 backend key — pulls existing state)
3. tofu plan
   (expect: ~40 K8s resources replaced, 1-2 moved, helm releases updated)
4. tofu apply
   (~2-5 min: old pods deleted, new pods created in new namespaces,
    cert re-issues in ~60s, DNS record unchanged)
5. Verify: curl https://workflow-engine.webredirect.org/livez
```

### Local environment

```
cd infrastructure/local && tofu destroy
(move files)
cd infrastructure/envs/local && tofu apply
```

### Rollback

If Phase 2 apply fails mid-way:
- `tofu apply` is idempotent — re-run resolves partial state
- If unrecoverable: `git revert` the Phase 2 commit, `tofu apply` recreates resources in old namespaces
- Persistence bucket is in separate state — unaffected by any rollback

## Open Questions

None — all decision branches resolved during design exploration.
