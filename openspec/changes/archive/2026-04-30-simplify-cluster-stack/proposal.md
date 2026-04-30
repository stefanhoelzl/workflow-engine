## Why

The cluster stack carries multiple abstractions that earned their keep when the system was bigger or differently shaped, but no longer do for a single-tenant, single-replica workload: Traefik (Helm chart + `IngressRoute`/`Middleware` CRDs) just to route one host to one Service, cert-manager (Helm chart + `ClusterIssuer` + `Certificate`) just to obtain one Let's Encrypt cert, and a `modules/netpol/` factory whose only surviving caller is the app itself. The result is ~700 LOC of OpenTofu, two Helm releases, four CRD kinds, and a `data.http`+`jsondecode` hack to discover the LB hostname — for a workload whose security headers, auth, and routing all live in the app. Replacing the ingress + TLS layer with a single Caddy Deployment (~40 LOC of K8s manifests, zero CRDs, zero Helm, ACME built in) and inlining the netpol factory into the only caller cuts cognitive load and ops time without changing the security posture, the IaC discipline, or the hosting platform.

## What Changes

- **BREAKING (infra-only)**: Replace Traefik (Helm chart + `IngressRoute`/`Middleware` CRDs) with Caddy (raw `kubernetes_manifest` Deployment + Service + ConfigMap + PVC). Cluster ingress moves to a new `modules/caddy/` module; `modules/traefik/` and `modules/app-instance/routes-chart/` are deleted.
- **BREAKING (infra-only)**: Replace cert-manager (Helm chart + `ClusterIssuer` + `Certificate` CRDs) with Caddy's built-in HTTP-01 ACME for prod/staging and Caddy's `tls internal` directive for the local kind stack. `modules/cert-manager/` is deleted; the `helm` provider is removed from every env.
- **BREAKING (infra-only)**: Inline the NetworkPolicy factory (`modules/netpol/`) into `modules/app-instance/`. The factory module is deleted; the surviving caller — the app pod's allowlist — is rendered as a direct `kubernetes_network_policy_v1` next to the Deployment. Cross-namespace ingress targets `caddy` instead of `traefik`. The S2 egress allowance survives only on the local-deployment code path.
- Replace the `data.http` + `jsondecode` LB-hostname discovery hack in `envs/cluster/cluster.tf` with the `upcloud` provider's native data source.
- Local kind stack stays. Its requirements are rewritten to mirror the prod contract with explicit `**Local deviation:**` sub-bullets (Service type=NodePort, no UpCloud annotation, `tls internal` instead of HTTP-01, S2 egress allowed). Browser self-signed warnings on `https://localhost:<port>` remain acceptable.
- Project conventions (`CLAUDE.md`, `docs/infrastructure.md`, `docs/dev-probes.md`, `SECURITY.md`) are updated to drop Traefik/cert-manager/Helm references and reflect the trimmed cluster-escalation list. Tasks-md template ("Cluster smoke (human)" block) survives; what triggers it shrinks.

**Non-goals** (called out so reviewers don't conflate scope):
- State layout (cluster, persistence, prod, staging envs) is **unchanged**.
- Client-side state encryption (pbkdf2 + aes_gcm) is **unchanged**.
- Ephemeral kubeconfig pattern in prod/staging is **unchanged**.
- Hosting (UpCloud Managed K8s + UpCloud Object Storage + Dynu DNS) is **unchanged**.
- Per-namespace default-deny `NetworkPolicy` (owned by `pod-security-baseline`) is **unchanged**. Only the per-pod factory abstraction is removed; both layers of NetworkPolicy still cover the app pod.
- App-side security (CSP/HSTS/Permissions-Policy via `secure-headers.ts`, OAuth login flow, session middleware, `apiAuthMiddleware`) is **unchanged**.
- Big-bang rollout: one PR, one apply per env. Brief LB-overlap window mitigated by standing up the Caddy Service before deleting the Traefik Service in the same apply.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `infrastructure`: rewrite the cluster-side ingress + TLS requirements (delete Traefik Helm release, cert-manager Helm release, `IngressRoute`/`Middleware` requirements, Helm provider declaration, `data.http` LB-hostname lookup; add Caddy Deployment + Service + ConfigMap + PVC + HTTP-01 ACME requirements under a new `## Cluster ingress (Caddy)` section; add app-pod `NetworkPolicy` contract under a new `## App networking` section; rewrite the local-stack section to mirror prod with explicit deviations).
- `network-policy-profiles`: **removed entirely**. The factory module is gone; the surviving app-pod allowlist requirement folds into `infrastructure` per the decision above. The `Traefik workload uses netpol factory` and `S2 workload uses netpol factory` requirements die outright (no Traefik; S2 ingress is a local-only deployment-time detail handled inline).

## Impact

**OpenTofu modules:**
- Deleted: `modules/traefik/`, `modules/cert-manager/`, `modules/netpol/`, `modules/app-instance/routes-chart/`
- Added: `modules/caddy/` (Deployment + Service + ConfigMap + PVC, ~40–60 LOC)
- Modified: `modules/app-instance/` (inline NetworkPolicy; drop `routes-chart` Helm sub-chart; consume Caddy Service backend label instead of `IngressRoute` host match), `modules/baseline/` (drop outputs no longer consumed once the netpol factory is gone)

**Envs:**
- `envs/cluster/`: drop `helm` provider; drop `module "traefik"`/`module "cert_manager"`; drop `data.http` LB lookup; add `module "caddy"` + `LoadBalancer` Service with the existing UpCloud `service.beta.kubernetes.io/upcloud-load-balancer-config` annotation; replace LB-hostname discovery with `upcloud` provider data source
- `envs/prod/` and `envs/staging/`: drop `helm` provider; drop `ClusterIssuer`/`Certificate` references; consume Caddy Service from cluster outputs instead of Traefik
- `envs/local/`: drop `helm` provider; drop `module "traefik"`/`module "cert_manager"`; add `module "caddy"` configured with `tls internal` and `Service.type=NodePort`

**Apps & contracts:**
- `secure-headers.ts`, OAuth, session middleware, all Hono routes — **untouched**. Caddy is a transparent reverse proxy; the app sees the same requests.
- The `local_deployment` flag on `modules/app-instance/` is still consumed for S2 egress in the inlined NetworkPolicy.

**CI:**
- `tofu fmt -check` + `tofu validate` already cover every env per `pnpm validate`. The `helm` provider removal trims `tofu init` time. No new CI surface.
- The pre-merge plan-gate for `infrastructure/envs/{cluster,persistence}/` per CLAUDE.md still applies; the operator runs the apply in the same window as the PR merge for the LB overlap to be brief.

**Docs:**
- `CLAUDE.md`: rewrite the `## Infrastructure` and `## Dev verification` sections (drop Traefik/cert-manager/Helm references; rewrite the cluster-escalation list).
- `docs/infrastructure.md`: rewrite the prod/staging runbook around Caddy + HTTP-01 ACME + `upcloud` LB data source.
- `docs/dev-probes.md`: drop Traefik-specific probes; add Caddy admin endpoint probe (`/metrics` if exposed).
- `SECURITY.md`: scrub residual Traefik-middleware references; the threat model is unchanged because security-relevant controls (CSP, HSTS, auth, default-deny NP, app-pod NP allowlist) all survive.

**Risk:**
- The big-bang apply briefly runs both LBs (Traefik + Caddy) until the operator switches the LB Service. Mitigated by: standing up the Caddy `LoadBalancer` Service first in the same plan, letting UpCloud allocate it a hostname, and only then deleting the Traefik release in a follow-up plan-gate apply if the operator wants extra safety. Acceptable since the project has documented brief downtime as tolerable for single-tenant deploys.
- `tls internal` in the local stack means browsers continue to surface a self-signed warning (status quo); accepted.
- Caddy stores its ACME account + cert on a `PVC`. Loss of that PVC triggers a re-issue (LE rate-limited but not at one cert/day for our domain count); operator runbook documents the recovery.
