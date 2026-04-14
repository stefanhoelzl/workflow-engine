## Why

The production cluster currently runs without any Kubernetes `NetworkPolicy`. Any pod in the `default` namespace can reach any other pod's ports — so the app's `:8080` is directly reachable bypassing Traefik, letting an attacker with a foothold on a neighboring pod forge `X-Auth-Request-User` and impersonate any allowed user (SECURITY.md §4 R-A3, §5 R-I1). Similarly, an action escaping the sandbox's SSRF controls can reach cloud metadata (`169.254.169.254`) and other internal endpoints (§2 R-S4, §5 R-I9). These are the three residual risks marked **High priority** in SECURITY.md §5 that can be closed with a single network-layer change.

A braided secondary concern: Traefik currently fetches its `inline-response` plugin from `github.com` on every pod startup, widening both its runtime egress needs and its supply-chain surface. Eliminating that runtime fetch lets us reason about Traefik's Internet egress as "ACME only" rather than "ACME + arbitrary GitHub".

## What Changes

- **Default-deny baseline**: one `NetworkPolicy` selecting all pods in `default` namespace, `policyTypes: [Ingress, Egress]`, with no allow rules. Without this, per-workload allows are no-ops.
- **App (workflow-engine) allow-rules**:
  - Egress to Internet (`0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`) — covers UpCloud Object Storage, `api.github.com`, `__hostFetch` targets.
  - Egress to CoreDNS in `kube-system` on UDP+TCP `:53`.
  - Ingress on `:8080` from Traefik pods only (`podSelector: app.kubernetes.io/name=traefik`).
  - Ingress on `:8080` from node CIDR `172.24.1.0/24` for kubelet probes.
- **oauth2-proxy allow-rules**:
  - Egress: same Internet-minus-private shape + CoreDNS.
  - Ingress on `:4180` from Traefik pods + node CIDR for probes.
- **Traefik allow-rules** (via existing `traefik_extra_objects` pipeline):
  - Egress: same Internet-minus-private shape + CoreDNS + in-cluster to app `:8080` and oauth2-proxy `:4180` by pod selector.
  - Ingress: `:80` and `:443` from `0.0.0.0/0` (public entry) + node CIDR on probe port.
- **Plugin vendoring** (braided sub-change):
  - Terraform fetches `traefik_inline_response-v0.1.2-src.tar.gz` from the immutable release-asset URL at apply time (pinned via `local.plugin_version`).
  - Stored in a `ConfigMap` (`binary_data`).
  - An init container extracts the tarball into an `emptyDir` at `/plugins-local/src/github.com/tuxgal/traefik_inline_response/`.
  - Traefik Helm value flips from `experimental.plugins.*` to `experimental.localPlugins.*`.
  - Removes runtime `github.com` dependency from the Traefik pod.
  - Integrity boundary is the release-asset URL + version pin (release assets are immutable via the normal upload path); no apply-time sha256 check is wired, to avoid the OpenTofu-side filesystem side effect otherwise needed to hash binary HTTP responses.
- **SECURITY.md updates**: move R-A3, R-I1, R-I9 to **Resolved**; re-scope R-S4 to "infrastructure half closed; app-layer URL allowlist still outstanding".

**Scope notes**:
- Policies are created in all envs; kindnet silently no-ops them locally. No toggle.
- NetworkPolicy cannot match hostnames; per-workload hostname allowlisting (e.g. oauth2-proxy → `github.com` only) requires `CiliumNetworkPolicy` or app-layer controls — out of scope here.
- Pod `securityContext` hardening (§5 R-I2), resource requests/limits (§5 R-I3), and the `__hostFetch` URL allowlist (§2 R-S4 app-layer half) are deliberately out of scope; each is its own follow-up.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `infrastructure`: adds a "Pod Network Policies" requirement cluster (default-deny, per-workload allow-lists, DNS + probe + CIDR shapes, kindnet enforcement semantics), and modifies the existing `Traefik Helm release` requirement to load the `traefik_inline_response` plugin via `experimental.localPlugins.*` from a ConfigMap-mounted source populated by an apply-time fetch, rather than via `experimental.plugins.*` runtime GitHub fetch.

## Impact

- **Code**: no application code changes.
- **Terraform**:
  - `infrastructure/modules/workflow-engine/workflow-engine.tf`: add namespace-wide default-deny NetworkPolicy; extend `traefik_extra_objects` with Traefik's allow-rule NetworkPolicy + plugin ConfigMap; extend `traefik_helm_values` with init container, volumes, and `localPlugins` block.
  - `infrastructure/modules/workflow-engine/modules/app/app.tf`: add app's allow-rule NetworkPolicy.
  - `infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf`: add oauth2-proxy's allow-rule NetworkPolicy.
- **Deployment**: first atomic apply to a scratch UpCloud UKS staging cluster, smoke-test, then apply to production. Rollback via `tofu state rm` of the NP resources.
- **Security**: resolves three High-priority residual risks in SECURITY.md (§4 R-A3, §5 R-I1, §5 R-I9). Partially mitigates §2 R-S4. SECURITY.md rewrite is part of the change.
- **Operational**: single-replica production means a misconfigured NP = brief outage. No multi-replica redundancy; staging-cluster dry run de-risks this.
- **Dependencies**: adds `hashicorp/http` provider usage in the workflow-engine module (already declared at root).
- **Compatibility**: kindnet (local) accepts NetworkPolicy resources but does not enforce. Local behavior unchanged. Production UpCloud UKS CNI (Cilium) enforces.
