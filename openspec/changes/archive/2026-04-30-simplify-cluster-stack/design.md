## Context

The workflow-engine cluster stack today is shaped for a much larger threat surface than it serves. A single workload — one app pod per env — runs behind:

- **Traefik** as the ingress gateway, installed via the `traefik/traefik` Helm chart, with a per-instance Helm sub-chart (`modules/app-instance/routes-chart/`) rendering `IngressRoute` and `Middleware` CRDs.
- **cert-manager** as the certificate controller, installed via Helm, plus a `letsencrypt-prod` `ClusterIssuer`, a per-app `Certificate` CRD, and a per-namespace `NetworkPolicy` for ACME HTTP-01 solver pods.
- **A NetworkPolicy factory module** (`modules/netpol/`) used by exactly two callers in prod (`app-instance` and Traefik) and three in local (+ S2). The factory's parameter surface — `egress_internet`, `egress_dns`, `egress_to`, `ingress_from_pods`, `ingress_from_cidrs`, `rfc1918_except`, `coredns_selector` — exists to let multiple workloads compose policies; only the app pod genuinely needs that breadth post-Traefik-removal.
- **A `data.http` + `jsondecode` block** in `envs/cluster/cluster.tf` that posts to `https://api.upcloud.com/1.3/load-balancer` and parses the JSON to discover the Traefik LB hostname, because the Service object doesn't expose it directly.

Together that's two Helm releases, four CRD kinds (`IngressRoute`, `Middleware`, `Certificate`, `ClusterIssuer`), three `helm` provider declarations across env files, and ~700 LOC of OpenTofu in modules that are about to lose their reason for being. The app itself is a Hono server: it owns CSP/HSTS/Permissions-Policy via `secure-headers.ts`, owns OAuth + session middleware, owns route dispatch (Traefik is a single catch-all → app), owns 5xx HTML rendering. Nothing in the ingress layer is doing work the app couldn't do unaided.

Caddy collapses the ingress + TLS layers into one binary. The full Caddyfile for our use case is `{$DOMAIN} { reverse_proxy workflow-engine:8080 }`. ACME is built in (HTTP-01 by default, DNS-01 via plugins). HTTP→HTTPS redirect is automatic. The cert lives on a `PVC`, which pins us to a single replica — and our stated constraint is "single instance is fine, brief downtime on deploy is acceptable."

## Goals / Non-Goals

**Goals:**

- Replace the Traefik + cert-manager + netpol-factory triplet with a single `modules/caddy/` Deployment + Service + ConfigMap + PVC, rendered via raw `kubernetes_manifest` resources.
- Eliminate the `helm` provider from every env (`cluster`, `prod`, `staging`, `local`).
- Inline the surviving NetworkPolicy (the app-pod allowlist) into `modules/app-instance/`. Delete `modules/netpol/`.
- Replace the `data.http` LB-hostname lookup with the `upcloud` provider's native data source.
- Keep the local kind stack alive; rewrite its spec section to mirror the prod contract with explicit `**Local deviation:**` sub-bullets (Service `NodePort` instead of `LoadBalancer`, `tls internal` instead of HTTP-01 ACME, S2 egress allowed, no UpCloud LB annotation, browser self-signed warning accepted).
- Preserve every app-side security control: CSP/HSTS/Permissions-Policy via `secure-headers.ts`, OAuth login flow, session/api middleware, all Hono routes.

**Non-Goals:**

- State layout (cluster + persistence + prod + staging) is unchanged. Decided in the interview against collapsing.
- Hosting platform (UpCloud Managed K8s + UpCloud Object Storage + Dynu DNS) is unchanged.
- Client-side state encryption (`pbkdf2` + `aes_gcm`) is unchanged.
- Ephemeral kubeconfig pattern in `envs/prod/` and `envs/staging/` is unchanged.
- Per-namespace default-deny `NetworkPolicy` (owned by `pod-security-baseline`) is unchanged. Only the per-pod factory abstraction goes away; both NP layers still cover the app pod.
- Multi-replica ingress is out of scope. The Caddy `PVC` for ACME storage pins us to one replica; that matches the stated constraint and matches today's behavior (Traefik is also single-replica today).
- Wildcard certs are out of scope. HTTP-01 (per-host) is sufficient for the current and planned domain count. DNS-01 + a custom Caddy build with the Dynu plugin is a future change if needed.
- App-side code changes are out of scope. The app does not learn that the ingress changed. (Verified: `secure-headers.ts` sets headers in Hono; no Traefik-set headers are relied on.)
- Resurrecting the `reverse-proxy` capability is out of scope. The precedent set by the prior `opentofu-dev` change is to fold cluster-side specs into `infrastructure`; we follow that precedent rather than reverse it.

## Decisions

### D1. Caddy as a raw Kubernetes Deployment, not a Helm chart

We render Caddy as `kubernetes_manifest` resources (Deployment + Service + ConfigMap + PVC) instead of using a Caddy Helm chart.

**Why:**
- The Caddy Helm chart's value of abstraction over the underlying manifests is small for our use case — we have one Caddyfile, one host, one upstream. The chart's flexibility (multi-host, multi-resolver, plugin builds) is value we don't consume.
- Removing Helm from the stack entirely is a stated goal. Keeping a Caddy Helm chart would force us to retain the `helm` provider and chart-version pinning.
- Raw manifests are auditable in the OpenTofu plan output. We can read the literal Deployment YAML in `tofu plan` rather than chasing chart values.

**Alternatives considered:**
- `caddyserver/caddy-ingress-controller` Helm chart — adds an Ingress-controller abstraction we don't need (a Caddyfile + reverse_proxy is simpler than `Ingress` resources).
- `Bjw-s/app-template` chart — generic chart wrapping Helm values around manifests. Same critique: extra abstraction without payoff for one workload.

**Trade-off accepted:** when Caddy upgrades, we manually bump the image tag in `modules/caddy/`. With a Helm chart we'd track upstream values changes too. For our cadence (Caddy is stable; we'd bump majors deliberately) the manual bump is the simpler path.

### D2. HTTP-01 ACME challenge, not DNS-01

Caddy's default ACME path. Cluster receives traffic on `:80` from the LB; Caddy responds to ACME challenges directly.

**Why:**
- HTTP-01 needs no provider plugin. The default Caddy image suffices.
- DNS-01 requires a custom Caddy build (xcaddy with the Dynu plugin), which means maintaining our own Caddy image. Out of scope.
- Wildcard certs are not needed (one host per env).

**Alternatives considered:**
- DNS-01 via Dynu — defer until the first time we need a wildcard cert. Tracked as a future change, not blocked by this one.
- TLS-ALPN-01 — cleaner than HTTP-01 (no port 80 exposure needed) but ACME servers prefer HTTP-01 + ACME-ALPN as a fallback; explicitly choosing TLS-ALPN-01 is unusual and adds operational surprise.

### D3. Single LoadBalancer Service with the existing UpCloud annotation, in `tcp` passthrough mode

The Caddy Service is `type=LoadBalancer` with `service.beta.kubernetes.io/upcloud-load-balancer-config` set to the same JSON shape used today (`frontends: [{name=web, mode=tcp}, {name=websecure, mode=tcp}]`).

**Why:**
- TLS terminates at Caddy (cluster-side), not at UpCloud LB. UpCloud LB is L4 passthrough as it is today.
- Keeping the LB shape identical means UpCloud doesn't reissue the LB or change its DNS name during the swap. Existing Dynu CNAME records keep working without DNS edits.
- Switching to UpCloud-managed-cert + L7 LB termination is a separate, larger change (requires `upcloud_loadbalancer_*` resources and an HTTP-mode frontend). Considered and rejected for this change as out-of-scope; would also create a hard dependency on a UpCloud product feature we currently don't use anywhere.

### D4. NetworkPolicy inlined into `modules/app-instance/`, factory module deleted

The app pod's `NetworkPolicy` is rendered as a direct `kubernetes_network_policy_v1` next to the Deployment, with the rules expressed inline (egress to internet-except-RFC1918, egress to CoreDNS, ingress from Caddy namespace on `:8080`, ingress from node CIDR on `:8080` for kubelet probes; on the `local_deployment` code path: also egress to S2 on `:9000`).

**Why:**
- The factory had three callers (app, Traefik, S2). After this change, only the app remains. A factory with one caller is just a function with a complicated parameter shape.
- Inlining keeps the policy next to the workload it protects. Reading `app-instance/netpol.tf` next to `app-instance/workloads.tf` is more direct than chasing a parameter chain through a separate module.

**Alternative considered:** keep `modules/netpol/`, call it once from `app-instance`. Rejected: the abstraction's only value is reuse; with one caller, it's pure overhead.

### D5. Local kind stack stays; spec mirrors prod with explicit deviations

The local stack's spec section is rewritten to use the same requirement structure as prod, with `**Local deviation:**` sub-bullets calling out the differences. The deviations are:

- Service type: `LoadBalancer` (prod) → `NodePort` (local)
- Caddy TLS: HTTP-01 ACME (prod) → `tls internal` directive (local)
- LB hostname discovery: `upcloud` data source (prod) → not applicable (local uses host port)
- DNS: Dynu CNAME (prod) → `localhost` or `/etc/hosts` (local)
- App image: GHCR digest (prod) → locally-built image with `imagePullPolicy: Never` (local)
- App NetworkPolicy egress: includes S2 on `:9000` (local-only deployment-time addition)

**Why:**
- Single source of truth for each requirement avoids prod/local drift in the spec.
- Browsers continue to surface a self-signed warning on `https://localhost:<port>` — same UX as today, no new behavior.
- `tls internal` removes the cert-manager + selfsigned-CA bootstrap chain entirely, which is the largest local-only complexity in the current setup.

### D6. Replace `data.http` LB-hostname lookup with `upcloud` provider data source

`envs/cluster/cluster.tf` lines 133–149 today post to `https://api.upcloud.com/1.3/load-balancer` via `hashicorp/http`, parse JSON, and find the LB whose `ccm_cluster_id` label matches the cluster. The `upcloud` provider exposes a load-balancer data source that does this lookup natively.

**Why:**
- One fewer provider (`hashicorp/http` is currently used only here).
- No JSON parsing in HCL.
- Cache behavior is provider-managed instead of `request_headers = { X-Tf-Dep = sha256(...) }` hacks to bust the HTTP cache.

**Alternative considered:** keep the `data.http` lookup. Rejected because we're already touching the cluster file for the Traefik → Caddy swap; the cleanup is cheap to bundle.

### D7. Big-bang rollout, with a brief LB-overlap mitigation

Per the interview, the migration is one PR. To soften the apply window:

1. Apply order — same as today's plan-gate flow: `cluster` first, then `prod`/`staging`.
2. The new Caddy `LoadBalancer` Service is created in the `cluster` apply *before* the Traefik release is destroyed (depend-on chain in `cluster.tf`). UpCloud allocates a hostname for the new LB; the Traefik LB is released afterwards.
3. The `Dynu` CNAME (owned by app projects) is updated in the same prod/staging apply to point at the new LB hostname.
4. Brief overlap: both LBs exist for ~30s during the cluster apply. Acceptable within the stated single-tenant downtime tolerance.

**Why not staged (cert-manager → Traefik-ACME first, then Traefik → Caddy)?** User chose big-bang in the interview. Rationale recorded: smaller PR cadence, easier to bisect a single failure.

### D8. Capability layout: fold deltas into `infrastructure`; delete `network-policy-profiles`

- `network-policy-profiles` capability is removed entirely. All four of its requirements either die outright (Traefik, S2 callers gone) or fold into a single new requirement on `infrastructure` (the surviving app-pod allowlist contract).
- `infrastructure` gains the new app-pod NetworkPolicy contract under a new section header `## App networking`, plus all Caddy-related requirements under `## Cluster ingress (Caddy)`.
- `reverse-proxy` capability stays empty (already emptied by `opentofu-dev`); we follow the established precedent of not resurrecting it.

**Why:** The codebase has already paid the cost of consolidating cluster-side specs into `infrastructure` once. Reversing that now would unwind a deliberate prior decision without a compelling forcing function. Section headers within `infrastructure/spec.md` provide enough navigability.

## Risks / Trade-offs

[**Risk: ACME provisioning fails on first apply** (Caddy can't reach LE because `:80` isn't routable from the public internet within the apply window)]
→ **Mitigation:** the LB Service annotation declares both `web` and `websecure` frontends. `:80` is reachable via the same LB hostname Dynu points at. Dynu CNAME propagates within minutes; LE's HTTP-01 retry budget covers DNS warm-up. If first issuance fails, Caddy retries on a backoff schedule (default: every 9 minutes for the first hour, exponential thereafter). Operator runbook documents `kubectl logs deploy/caddy -n caddy | grep certmagic` as the diagnostic command.

[**Risk: Caddy `PVC` loss → cert re-issuance** triggered, hitting LE rate limits if it happens repeatedly]
→ **Mitigation:** the `PVC` uses UpCloud's persistent storage class with retention beyond pod restarts. PVC loss requires the underlying UpCloud volume to be deleted, which only happens via `tofu destroy` of the Caddy module. LE rate limit for our domain count (one per env) is far above the actual issuance rate. Operator runbook documents that `tofu apply -replace=module.caddy.kubernetes_persistent_volume_claim_v1.cert_storage` triggers a deliberate re-issuance.

[**Risk: Traefik-specific behaviors that the app silently relies on** are missed during migration]
→ **Mitigation:** the only Traefik features in use today are (a) TLS termination, (b) HTTP→HTTPS redirect, (c) catch-all routing to one Service. All three are Caddy defaults. Verified by inspection of `routes-chart/templates/routes.yaml` (single catch-all `IngressRoute` + `redirect-to-https` `Middleware`, no other middlewares). The app's `secure-headers.ts` confirms response headers are app-set, not Traefik-set.

[**Risk: Caddy admin endpoint exposed inadvertently**]
→ **Mitigation:** Caddy's admin endpoint is `localhost:2019` by default (not exposed via Service). The Caddyfile sets `admin off` to disable it entirely; no admin endpoint exists. `dev-probes.md` is updated to reflect this.

[**Risk: HTTP/2 or HTTP/3 differences between Caddy and Traefik** affect client behavior (e.g., dashboard SSE)]
→ **Mitigation:** the dashboard is server-rendered HTML; SSE streams tested against Caddy in the local kind stack (using `tls internal`) before merge. Caddy supports HTTP/2 and HTTP/3 by default; QUIC requires UDP passthrough at the LB which our `tcp` mode allows.

[**Risk: PSA `restricted` profile rejects the Caddy pod** (e.g., capabilities, runAsNonRoot)]
→ **Mitigation:** the Caddy upstream image runs as non-root by default and needs no Linux capabilities. The Deployment manifest sets `runAsNonRoot: true`, `runAsUser: 65532`, `seccompProfile: RuntimeDefault`, `capabilities.drop: [ALL]`, `readOnlyRootFilesystem: true` (with `emptyDir` volumes for `/config` + `/var/log`). These are the same security context values applied to Traefik today; verified compatible with PSA `restricted`.

[**Risk: SECURITY.md drift** — references to Traefik middleware or forward-auth left dangling]
→ **Mitigation:** the change includes a SECURITY.md scrub. Specifically: anywhere SECURITY.md mentions Traefik middleware, the language is updated to reference the app's `secure-headers.ts` (which already owned those headers); forward-auth was already removed in a prior change so there should be no live references, but a grep is included in the task list.

## Migration Plan

The migration runs as one PR with these apply steps. Steps 1–4 are author-side (PR contents); steps 5–7 are operator-side (the plan-gate apply window).

1. **Add `modules/caddy/`** with Deployment + Service + ConfigMap + PVC + ServiceAccount manifests.
2. **Modify `modules/app-instance/`**: inline NetworkPolicy (delete `helm_release "routes"` for the routes-chart; replace with a `kubernetes_service_v1` selector match by label or by name reference to the Caddy upstream); remove `routes-chart/` subdirectory; remove `active_issuer_name` and Certificate-related inputs.
3. **Modify `envs/cluster/cluster.tf`**: drop `helm` provider; drop `module "traefik"` and `module "cert_manager"`; add `module "caddy"`; replace `data.http` LB lookup with `upcloud` provider data source; update outputs (drop `active_issuer_name`).
4. **Modify `envs/prod/prod.tf` and `envs/staging/staging.tf`**: drop `helm` provider; drop `active_issuer_name` and Certificate references; consume Caddy Service backend from cluster outputs.
5. **Modify `envs/local/local.tf`**: drop `helm` provider; drop Traefik + cert-manager modules; add Caddy module configured with `tls internal` and `Service.type=NodePort`.
6. **Update docs**: `CLAUDE.md` (Infrastructure section + escalation list), `docs/infrastructure.md` (operator runbook), `docs/dev-probes.md` (drop Traefik probes, add Caddy probes), `SECURITY.md` (scrub Traefik middleware references).
7. **Delete modules**: `modules/traefik/`, `modules/cert-manager/`, `modules/netpol/`, `modules/app-instance/routes-chart/`.

**Operator apply order (the plan-gate window):**

1. `cd infrastructure/envs/cluster && tofu plan` — review the Caddy Deployment, Service, and the Traefik/cert-manager destroys. Verify the new LB Service is created *before* Traefik's destroy in the dependency graph.
2. `tofu apply` — UpCloud allocates a new LB for Caddy; old Traefik LB is released.
3. `cd ../prod && tofu plan` — review NetworkPolicy inlining, removal of Certificate + IngressRoute resources, and the new Caddy Service backend.
4. `tofu apply` — prod app NP updates; old Certificate and IngressRoute are deleted.
5. `cd ../staging && tofu plan && tofu apply` — same as prod.
6. **Verify:** `curl -I https://workflow-engine.webredirect.org` returns 200 with HSTS, CSP, and the LE-issued cert. `kubectl logs deploy/caddy -n caddy | grep "certificate obtained"` confirms ACME success.
7. **Optional next-day cleanup:** verify Dynu CNAME is healthy; nothing to roll back.

**Rollback strategy:** If the apply fails partway, the rollback path is `git revert` + `tofu apply` per env in reverse order (staging → prod → cluster). Because state is encrypted and per-env, partial rollback is bounded to one env at a time.

## Open Questions

None. All decisions resolved in the interview/explore phases. Specifically:

- TLS path: locked on Caddy built-in HTTP-01 ACME (D2).
- Caddy delivery: locked on raw `kubernetes_manifest`, no Helm (D1).
- LB shape: locked on `tcp` passthrough with existing UpCloud annotation (D3).
- NetworkPolicy: locked on inline (D4).
- Local stack: locked on keep-with-deviations (D5).
- Capability layout: locked on fold-into-infrastructure, delete `network-policy-profiles` (D8).
- Rollout: locked on big-bang (D7).

If any of these need revisiting during implementation, a design.md amendment is preferable to a silent deviation.
