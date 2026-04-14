## Context

The production UpCloud deployment currently uses Traefik's built-in ACME resolver to obtain Let's Encrypt certificates via TLS-ALPN-01 challenge, storing the resulting `acme.json` on a 1Gi `upcloud-block-storage-standard` PVC mounted at `/data`. This works but carries three drawbacks:

1. **Cost**: a 1Gi block-storage disk bills continuously for what is, in steady state, <10KB of cert data.
2. **Coupling**: cert issuance is entangled with Traefik. Swapping the ingress later means re-solving cert lifecycle.
3. **Opacity**: cert renewal lives in Traefik logs. There is no CRD-level observability (`kubectl get certificate`).

The local kind environment has no TLS configuration (`var.tls = null`); Traefik serves its built-in self-signed cert. This means the prod and local deployments exercise different IngressRoute wiring, so shape mismatches in the workflow-engine module's `tls` variable are only caught during prod apply.

cert-manager is the de-facto standard for ACME-from-K8s. It issues certs into Secrets (no PVC), exposes Certificate/Issuer CRDs for kubectl-level observability, and is ingress-agnostic.

## Goals / Non-Goals

**Goals:**
- Replace Traefik's built-in ACME resolver with jetstack/cert-manager.
- Remove the 1Gi UpCloud block-storage PVC (and the underlying disk).
- Add wiring parity between local and prod — both environments use the same `tls = { secretName }` variable shape and exercise the same IngressRoute code path.
- Keep all current routing behavior identical from the user's perspective (same paths, same auth, same error pages).
- Make port 80 semantics explicit: ACME solver, `/error` loopback, catch-all HTTPS redirect. Remove the "port 80 returns 404" wart.
- **Single-command `tofu apply` on any state** (fresh or existing). No two-stage bootstrap dance.

**Non-Goals:**
- Multi-replica Traefik (PVC was the blocker, but replica changes are out of scope).
- Wildcard certs (HTTP-01 can't issue wildcards; we don't need them today).
- Removing browser warnings on local — the self-signed CA is not trust-anchored into the host OS. Doable later, out of scope here.
- Changing the DNS provider or domain.
- Any runtime/app code changes. This is an infrastructure-only change.
- Synchronous cert-issuance wait during `tofu apply` — traded away for single-command apply. Operators who want fast-fail on issuance errors run `kubectl wait` post-apply (documented in CLAUDE.md).

## Decisions

### Use jetstack/cert-manager (over alternatives)

**Decision**: Install `jetstack/cert-manager` via Helm, pinned version.

**Alternatives considered**:
- Caddy (replaces Traefik entirely — too broad a scope).
- kube-lego (deprecated).
- smallstep `step-issuer` (private CA, not ACME).
- DIY certbot CronJob (reinvents cert-manager poorly).

cert-manager is CNCF-graduated and the industry default. No real competitor for "ACME-issued certs as K8s Secrets."

### HTTP-01 over DNS-01 or TLS-ALPN-01

**Decision**: HTTP-01 challenge via cert-manager's standard-Ingress solver (`ingressClassName: traefik`).

**Alternatives considered**:
- DNS-01 via Dynu: would need a community webhook solver (no first-party Dynu integration in cert-manager). More moving parts and a chicken-and-egg bootstrap.
- TLS-ALPN-01: what we have today; cert-manager's implementation is less common and fights for port 443 with Traefik.

HTTP-01 works because port 80 is already exposed on the UpCloud LB (both `web` and `websecure` frontends are in the LB config). cert-manager's solver creates a standard k8s Ingress on `/.well-known/acme-challenge/<token>`; Traefik's default IngressClass picks it up.

### ClusterIssuer scope (not Issuer)

**Decision**: ClusterIssuer for both `letsencrypt-prod` and the self-signed CA chain.

Namespaced Issuers would be scoped to `default`, but there is no other namespace that might benefit from tighter scope. ClusterIssuer is the idiomatic choice for a single-namespace deployment and keeps the module parameter-free on namespace concerns.

### Prod-only ClusterIssuer (drop `letsencrypt_staging`)

**Decision**: Ship only `letsencrypt-prod`. Drop the `letsencrypt_staging` variable.

Let's Encrypt rate-limit risk is low for a single-domain single-cert setup (50 certs/registered domain/week, 5 failed validations/account/hostname/hour). cert-manager retries with exponential backoff; rate-limit hits recover on their own. The staging issuer added surface area (two issuers, conditional logic in the workflow-engine module) for a risk we will rarely hit. Tradeoff accepted.

If we ever want staging back, it's a one-issuer-manifest addition.

### cert-manager module owns ALL cert-manager custom resources

**Decision**: The cert-manager module is the sole place where `cert-manager.io/v1` resources (ClusterIssuers, Certificates, including leaf certs) are declared. The module takes a `certificate_requests` input list (`[{ name, namespace, secretName, dnsNames }]`) and synthesizes Certificate manifests for each entry. All these resources are emitted via a second, module-internal `helm_release` that renders a tiny local chart (`cert-manager-extras`) whose only job is to iterate over a `values.extraObjects` list of YAML-string documents. That second release `depends_on` the primary cert-manager Helm release, guaranteeing cert-manager's CRDs are registered in the cluster's API discovery before the CR manifests are rendered and applied.

**Why two releases inside one module**:

cert-manager's own Helm chart *does* expose an `extraObjects` values key (confirmed in the chart's `values.yaml`), but it cannot install CR manifests in the same release that registers the CRDs. Helm resolves Kubernetes kinds (RESTMapper lookup via API discovery) for every rendered manifest *before* applying anything. At that point the release has not yet installed any CRDs, so `cert-manager.io/v1 Certificate` / `ClusterIssuer` kinds are unknown and the install fails with `resource mapping not found`. A second release sidesteps this: it renders after the first release has fully applied CRDs and controllers, so kind resolution succeeds. From the caller's perspective the module boundary is unchanged — still `module "cert_manager" {}` with the same input shape — the split is an implementation detail inside the module.

**Alternatives considered**:
- `kubernetes_manifest` resources for ClusterIssuers and Certificates (tried first): blocked by the provider's plan-time OpenAPI validation of custom resources. On a fresh state with no cluster or cert-manager CRDs, plan fails before apply can install the CRDs. The workaround is a two-stage `tofu apply` (`tofu apply -target=...` first), which is painful to run on every `destroy → up` cycle in local development.
- Single helm_release for both cert-manager and extraObjects (initial 3a attempt): fails at install time with Helm's kind-resolution error described above.
- Subchart bundle (declare cert-manager as a dependency of the local chart): works in principle, but the `hashicorp/helm` provider does not run `helm dependency update` automatically. Either the cert-manager chart tarball has to be committed to the repo (~500KB binary blob) or a shell pre-apply hook has to run `helm dep update`. Rejected as heavier than two releases.
- Adding a non-hashicorp provider (gavinbunney/kubectl or alekc/kubectl): defers validation to apply time and supports wait-on-Ready, but adds a third-party provider dependency.

Going with two helm releases keeps the provider footprint minimal (only hashicorp providers), solves the bootstrap problem cleanly, and is transparent to callers. The trade-off is losing `kubernetes_manifest.wait` on Certificate readiness — see the next decision.

### No synchronous wait on Certificate issuance

**Decision**: `tofu apply` returns once the cert-manager `helm_release` completes (pods Ready). Actual cert issuance happens asynchronously: cert-manager reconciles the Certificate, performs the ACME HTTP-01 challenge (prod) or signs with the in-cluster CA (local), writes the Secret, and Traefik picks it up.

**Consequence**: on first apply, there is a brief window where HTTPS is not yet served — seconds for self-signed, 30-90 seconds for ACME. Subsequent applies (no cert changes) have no window.

**Alternatives considered**:
- `kubernetes_manifest.wait` on the Certificate (original design): requires using `kubernetes_manifest` for Certificates, which reintroduces the plan-time validation problem and the two-stage bootstrap.
- `null_resource` + `kubectl wait`: requires kubectl on PATH and kubeconfig on disk; fights the ephemeral-credentials posture of the UpCloud module.
- Adding a non-hashicorp provider (kubectl): deferred validation + wait_for_rollout, but adds a dependency.
- `time_sleep`: racy; no real correctness guarantees.

**Mitigation for fast-fail needs**: CLAUDE.md documents a one-liner `kubectl wait --for=condition=Ready certificate/workflow-engine -n default --timeout=5m` operators can run post-apply if they want the fast-fail behavior. It's an opt-in for a narrow scenario (first-apply with misconfigured DNS / port 80 / CAA records), not a default.

**Why this is acceptable**: cert-issuance failures are rare once the deployment is set up. The only real loss is a ~5-minute slower feedback loop on the first-ever prod deployment with a misconfiguration. All other scenarios (ongoing operation, renewal, local dev) are unaffected or improved.

### CRDs installed via Helm (`installCRDs=true`)

**Decision**: The cert-manager Helm release uses `installCRDs=true`. No separate CRD apply phase.

**Alternative considered**: applying CRDs via `kubernetes_manifest` resources in a separate phase. This was the original design, intended to decouple CRD lifecycle from the Helm release. It is dropped because:
- `kubernetes_manifest` for CRDs (even though CRD itself is a built-in K8s kind) requires the cluster to be accessible at plan time. On a fresh `tofu apply` with no cluster, this fails.
- The two-stage bootstrap workaround is painful on every destroy/apply cycle.
- `installCRDs=true` has a known limitation — Helm installs CRDs only on first install, not on upgrades. We accept this because cert-manager chart version bumps are rare and manual; when we bump, we can apply `kubectl apply -f cert-manager.crds.yaml` once before the Helm upgrade if needed. Documented in CLAUDE.md.

### Port 80 gets an explicit HTTP→HTTPS redirect

**Decision**: Add a Middleware of type `redirectScheme` (scheme=https, permanent=true) and a catch-all IngressRoute on the `web` entrypoint with `priority = 1` using that middleware.

Today port 80 returns 404 for any path except `/error`. The redirect is a small UX improvement (users typing `http://...` get upgraded instead of 404'd) and also encodes the "don't redirect ACME / don't redirect /error" rule in the structure of the config rather than in a documentation comment.

Priority is explicit (`priority = 1`) AND both `/error` and `/.well-known/acme-challenge/<token>` are more-specific paths that win on rule-length ordering. Belt and suspenders.

### Local parity via self-signed CA chain

**Decision**: Install cert-manager locally too, with a CA-backed selfsigned chain (`selfsigned-bootstrap` → CA Certificate → `selfsigned-ca` CA-ClusterIssuer → leaf cert).

Local now passes the same `tls = { secretName }` shape as prod. The IngressRoute code path and the cert-request → Certificate emission plumbing are exercised locally, catching wiring bugs before they reach prod.

Cost: ~45-90s added to first local apply (one-time), ~10s steady-state. The cert-manager module has ~30 LOC of conditional logic to emit the selfsigned CA chain in `extraObjects`, offset by slight simplification in the workflow-engine module (the `tls` variable shrinks to just `secretName`).

Browser warnings remain (CA not in host trust store) — out of scope.

## Risks / Trade-offs

**[Risk] First-apply HTTPS gap (seconds to minutes)**
On first prod apply, cert-manager issues the ACME cert asynchronously — `tofu apply` returns before the Secret exists. HTTPS returns TLS-handshake errors for 30-90 seconds, then starts working as Traefik reloads. For local (self-signed), the gap is a few seconds.
→ Mitigation: an opt-in `kubectl wait --for=condition=Ready certificate/...` one-liner in CLAUDE.md for operators who want apply to block until issuance succeeds. For automation/CI, run the wait as a post-apply step.

**[Risk] Misconfigured prod deploy: slower feedback**
If DNS is wrong, port 80 is blocked by an external firewall, or CAA records block Let's Encrypt, `tofu apply` completes successfully but the cert never issues. Operators discover this via `kubectl get certificate -n default` or a browser test.
→ Mitigation: the `kubectl wait` one-liner above surfaces the failure in 5 minutes. Subsequent observability via `kubectl describe certificate` shows actionable errors (cert-manager condition messages).

**[Risk] LE rate limits if cert-manager misconfigures**
5 failed validations per account per hostname per hour. Initial apply could burn through this if HTTP-01 is misconfigured (e.g., solver Ingress unreachable).
→ Mitigation: validate HTTP-01 solver path reachability (LB port 80 → Traefik → solver pod) before first prod apply by hitting `http://workflow-engine.webredirect.org/.well-known/acme-challenge/test` and inspecting Traefik logs. Only attempt prod issuance after local apply confirms the wiring. Also: cert-manager's default backoff gives hours of breathing room before hitting weekly limits.

**[Risk] Priority bug on port 80 eats ACME or /error**
If the catch-all redirect priority is wrong (or Traefik rule-ordering behavior changes), ACME challenges or 5xx pages could be served as 301 redirects.
→ Mitigation: explicit `priority = 1` on the catch-all AND the other two paths are more-specific (win on rule-length ordering). Both mechanisms must fail simultaneously for this to break. Also: one scenario in the spec explicitly tests that ACME challenges are not redirected, and another that the /error loopback is not redirected.

**[Risk] Future http→https redirect might block ACME renewal**
The HTTP-01 solver requires reachability on plain HTTP. If a future change adds an entrypoint-level redirect (`ports.web.redirectTo`) or another middleware that catches `/.well-known/acme-challenge/*`, cert renewal silently fails until the cert expires.
→ Mitigation: the spec requires that the catch-all redirect exclude the ACME challenge path (via rule specificity). Any future change that adds a broader redirect must update this spec.

**[Risk] Installing cert-manager adds cluster-wide RBAC surface**
cert-manager runs with permissions to create Secrets cluster-wide and manipulate ClusterIssuer-scoped resources. ClusterIssuer is cluster-scoped by definition.
→ Mitigation: the Helm chart's default RBAC is the vetted upstream policy. We accept it as the standard cost of running cert-manager. No app pod gets any new permissions.

**[Risk] CRD upgrades via `installCRDs=true` don't fire on Helm upgrades**
Helm's `installCRDs=true` only installs CRDs on first install, not on subsequent `helm upgrade` calls. If cert-manager chart version is bumped and the new version adds/changes CRD fields, Helm may apply new CR manifests that the old CRDs can't validate.
→ Mitigation: when bumping the cert-manager chart version, also run `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/<new-version>/cert-manager.crds.yaml` once before the tofu apply that bumps the chart. Documented in CLAUDE.md as part of the chart-upgrade procedure.

**[Risk] Reconciliation races on first apply**
Helm installs extraObjects in no guaranteed order relative to cert-manager controller readiness. Certificate resources may log transient errors ("no webhook registered for cert-manager.io", "ClusterIssuer not ready") during the first 10-60s.
→ Mitigation: cert-manager's reconciliation loop self-heals these transient errors. The primary Helm release has `wait=true` (including cert-manager's `startupapicheck` job which verifies the webhook is serving), and the extras release `depends_on` it — so by the time extras are applied, the webhook is ready. No operator action needed.

**[Risk] OpenTofu heterogeneous-tuple typing**
Conditional expressions like `var.enable_x ? [obj_A, obj_B, obj_C] : []` fail with "Inconsistent conditional result types" when the objects have different shapes (e.g., a ClusterIssuer spec and a Certificate spec). OpenTofu treats tuples as exact types where element structure must match.
→ Mitigation: the cert-manager module encodes each manifest to a YAML string via `yamlencode()` up front, so all local lists are `list(string)` — uniform type regardless of content shape. Documented via code comments in `cert-manager.tf`.

## Open Questions

- Should the cert-manager module expose any outputs besides ClusterIssuer names (e.g., Helm release ID for implicit dependencies)? — Leaning yes, similar to the routing module's `helm_release_id` output. Decide during implementation when we see what consumers need.
- Does this change require updating `/SECURITY.md §5` for the new cert-manager RBAC surface and changed cert storage location? — Yes for the RBAC mention. Concrete scope decided during implementation when writing the SECURITY.md update task.
