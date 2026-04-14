## Context

The production K8s cluster (UpCloud UKS, Cilium CNI) currently runs with **no `NetworkPolicy`**. Three High-priority risks in SECURITY.md trace directly to this gap:

- **§4 R-A3**: any pod can reach `app:8080` directly and forge `X-Auth-Request-User` to impersonate any user on the oauth2-proxy allowlist.
- **§5 R-I1**: all-to-all pod connectivity — a compromised neighbor is one hop from every other pod's ports.
- **§5 R-I9**: no egress restriction — a sandbox escape (combined with §2 R-S4) can reach `169.254.169.254` cloud metadata, RFC1918 internal endpoints, and any public URL.

A fourth, braided concern surfaced while scoping egress: Traefik currently loads the `inline-response` plugin by fetching a ZIP archive from `github.com/tuxgal/traefik_inline_response/archive/...zip` **on every pod startup**. This means any egress policy must keep `github.com` reachable from Traefik at runtime, widening Traefik's Internet exposure and creating a hard dependency on GitHub's availability during ACME renewals, HPA scale-ups, or unrelated pod restarts.

The production target runs a single-replica deployment. Any misconfigured NetworkPolicy immediately causes user-visible outage until corrected; there is no multi-replica redundancy to mask a bad apply.

## Goals / Non-Goals

**Goals:**
- Close §4 R-A3, §5 R-I1, §5 R-I9 in a single OpenSpec change.
- Keep every egress destination the application legitimately needs reachable (UpCloud Object Storage public endpoint, `api.github.com`, `github.com`/`api.github.com` for oauth2-proxy, Let's Encrypt ACME).
- Eliminate Traefik's runtime `github.com` dependency by vendoring the `inline-response` plugin source at apply time.
- Preserve the branded 5xx error page in all failure modes, including when the app pod is down.
- Keep the local kind environment unchanged behaviorally (kindnet silently ignores NetworkPolicy).
- Pin plugin supply-chain integrity via sha256 against the release asset's published checksum.

**Non-Goals:**
- App-layer URL allowlisting in `__hostFetch` (§2 R-S4 app-layer half remains open).
- Pod `securityContext` hardening (§5 R-I2).
- Resource requests/limits on pods (§5 R-I3).
- FQDN-level egress scoping (would require `CiliumNetworkPolicy`; stock `NetworkPolicy` only matches CIDRs).
- PGP signature verification of the plugin tarball.
- Swapping kind's CNI to a policy-enforcing one so local enforcement matches production.

## Decisions

### D1. Namespace-wide default-deny + per-workload allow-rules

**Decision:** one `NetworkPolicy` with `podSelector: {}` and `policyTypes: [Ingress, Egress]` and no allow rules, plus three additional `NetworkPolicy` objects (app, oauth2-proxy, Traefik) each with narrower `podSelector` and explicit allow lists.

**Alternatives considered:**
- **App-only policy** — would leave oauth2-proxy and Traefik open, failing to close R-I1 for those pods. Rejected; the threat model calls for namespace-wide hardening.
- **One NetworkPolicy per pod containing both default-deny and allows** — K8s NetworkPolicy semantics make this awkward (a single selecting policy already acts as deny-by-default for whatever directions it names). Separate files are clearer.
- **Allow-lists inlined into each pod's Deployment manifest** — couples policy lifecycle too tightly to workload rollout. Current choice keeps each allow-rule in its workload's TF module but as a distinct k8s resource.

### D2. CIDR carve-out shape: `0.0.0.0/0` except RFC1918 + 169.254/16

**Decision:** egress `ipBlock` uses `cidr: 0.0.0.0/0` with `except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]`.

**Rationale:** this is the strongest posture expressible in stock `NetworkPolicy`. It blocks:
- IMDS/link-local metadata (`169.254.169.254`).
- All three RFC1918 ranges, covering both the UpCloud node network (`172.24.1.0/24` inside `172.16/12`) and any cluster pod/service CIDRs (typically inside `10.0.0.0/8`).

UpCloud Object Storage resolves to public IPs outside these ranges (verified: `94.237.89.194`, `5.22.212.201`), so the rule passes legitimate traffic.

**Alternatives considered:**
- **RFC1918-only exclusion** — leaves metadata reachable; rejected.
- **Paranoid exclusion** (adding `100.64.0.0/10`, `127.0.0.0/8`, `fd00::/8`, `fe80::/10`) — IPv6 CIDRs require a separate ipBlock rule; UpCloud nodes are IPv4-only in the current deployment. Defer until IPv6 is enabled.
- **FQDN allowlist via `CiliumNetworkPolicy`** — would let us scope oauth2-proxy to `github.com` only, Traefik to `acme-v02.api.letsencrypt.org` only, etc. Rejected for v1 because (a) it ties us to Cilium-specific CRDs rather than vanilla k8s, (b) local kind would need a fully different approach, (c) hostname scoping can be layered in later without disturbing the CIDR rules.

### D3. DNS rule via pod/namespace selector, not a broad `:53 to 0.0.0.0/0`

**Decision:** separate egress rule `to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }]` on UDP+TCP `:53`.

**Rationale:** CoreDNS sits at a ClusterIP inside `10.0.0.0/8`, which our carve-out blocks. K8s NetworkPolicy semantics in Cilium evaluate after kube-proxy/CNI DNAT, so matching on the CoreDNS pod/namespace selector works regardless of the ClusterIP. Using `namespaceSelector` on `kubernetes.io/metadata.name` works because UpCloud UKS runs k8s 1.34 (the label has been stable since 1.22).

**Alternatives considered:**
- **Allow `:53` to `0.0.0.0/0`** — looser and allows the sandbox to resolve via public DNS if `resolv.conf` is overridden, a capability we don't want.
- **UDP-only** — DNS over TCP is used for large responses (EDNS truncation) and some resolvers force it; blocking TCP :53 occasionally manifests as flaky resolution.

### D4. Kubelet probe allow rule via node CIDR

**Decision:** separate ingress rule `from: [{ ipBlock: { cidr: "172.24.1.0/24" } }]` on each pod's probe port.

**Rationale:** Cilium (unlike some Calico configurations) does NOT exempt node→pod traffic from NetworkPolicy enforcement. Without an explicit allow, kubelet health probes fail, pods go `NotReady`, and the deployment enters a crash loop. The UpCloud node network CIDR `172.24.1.0/24` is hardcoded in `infrastructure/modules/kubernetes/upcloud/upcloud.tf`; we depend on that value.

**Alternative considered:** allow probes from `0.0.0.0/0` on probe paths — simpler but permits any pod to hit `/healthz`, `/ping`, etc., which leak readiness information.

### D5. Traefik ingress from `0.0.0.0/0` on `:80`/`:443`

**Decision:** Traefik is the public ingress; ingress rule `from: [{ ipBlock: { cidr: "0.0.0.0/0" } }]` on `TCP :80` and `TCP :443`, plus node CIDR on the probe port.

**Rationale:** the UpCloud LoadBalancer terminates nothing — it forwards TCP to Traefik. Traffic source IPs at the Traefik pod are a mix of the LB's internal IPs and (with `externalTrafficPolicy: Cluster`, the current default) kube-proxy-masqueraded node IPs. The simplest correct rule is to accept any source on the public entrypoint ports. Admin/dashboard ports remain blocked by default-deny because we never add them to the allow list.

### D6. Braided: vendor the Traefik `inline-response` plugin at apply time

**Decision:** fetch `traefik_inline_response-v0.1.2-src.tar.gz` from the GitHub **release asset URL** (immutable via the normal upload path, unlike auto-generated `/archive/` tarballs), store in a `ConfigMap` `binary_data` field, and extract at pod-start via an init container into a shared `emptyDir`. Flip the Traefik Helm chart from `experimental.plugins.*` to `experimental.localPlugins.*`. No apply-time sha256 verification (see D6a).

**Rationale:**
- Release assets at `/releases/download/<tag>/<name>` are immutable via the normal upload path. Auto-generated `/archive/` tarballs, by contrast, can be silently re-compressed; the release asset path is the correct integrity boundary.
- The tarball is 735 KB; base64 encodes to ~978 KB on the wire, inside the 1 MiB ConfigMap soft limit and under etcd's 1.5 MiB hard limit.
- Shifting the fetch to the operator workstation at apply time is the only option (of those considered) that preserves the existing behavior (branded 5xx in all scenarios) without introducing a custom Traefik image or committing vendored source to the repo.

**Alternatives considered:**
- **Custom Traefik image** — bakes plugin into image; eliminates fetch entirely; requires a second image build pipeline. Heavier operational cost.
- **Drop the plugin entirely; serve `/static/500.html` from the app** — smallest diff, but the pretty 5xx page would be absent exactly when the app is down (which is the most common 5xx scenario for a single-replica deployment). Rejected after the tradeoff was re-examined.
- **Commit vendored plugin source to the repo** — clean but means reviewing Go source we don't otherwise touch at every dependency update. Apply-time fetch is a lighter operator workflow.

### D6a. No apply-time sha256 check on the plugin tarball

**Decision:** integrity relies on the release-asset URL + `local.plugin_version` pin alone. No `sha256` verification at apply time.

**Rationale:** OpenTofu cannot ergonomically hash binary HTTP responses in-memory. `sha256(data.http.X.response_body)` mangles non-UTF-8 bytes (OpenTofu emits a "Response body is not recognized as UTF-8" warning and the computed hash does not match the true sha256 of the raw bytes). `base64decode(response_body_base64)` errors when the decoded bytes are not valid UTF-8. The workable alternatives all introduce side-effects disproportionate to the threat:

- **`local_sensitive_file` + `filesha256()`** — works, but writes a `.plugin-cache/` file to the operator filesystem purely to compute a hash; adds a `hashicorp/local` provider to two root modules.
- **`external` data source invoking `sha256sum`** — adds the `hashicorp/external` provider, shells out on every plan, depends on POSIX tools on the operator workstation.
- **Init-container `sha256sum -c` sidecar** — cleanest technically (verification inline with consumption), but moves failure mode from "apply fails fast" to "pod CrashLoopBackOff discovered via kubectl".

None of these defend against "upstream maintainer deletes and re-uploads a tampered release asset" — that attack requires account compromise and is equally detectable by reviewing the release history on upgrade. The URL + version pin is the pragmatic boundary. Revisit if the plugin source changes trust domains (e.g. a fork under different ownership).

**Alternatives considered:** see bullets above.

### D7. Delivery locations for each NetworkPolicy

**Decision:**
- Default-deny NetworkPolicy: declared in `modules/workflow-engine/workflow-engine.tf` (the umbrella).
- App allow-rule: declared in `modules/workflow-engine/modules/app/app.tf` next to the Deployment it protects.
- oauth2-proxy allow-rule: declared in `modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf` next to its Deployment.
- Traefik allow-rule + plugin ConfigMap: declared in `modules/workflow-engine/workflow-engine.tf` and delivered through the existing `traefik_extra_objects` output pipeline (Helm-managed, consistent with Middlewares and IngressRoutes).
- Init container + volumes for plugin extraction: injected via existing `traefik_helm_values` output, consumed by `modules/routing`.

**Rationale:** co-locates each workload's allow-rule with its own Deployment; keeps Traefik's network + plugin concerns together where the existing Traefik-adjacent objects already live.

### D8. Policies created in all environments (kindnet no-op)

**Decision:** no `enable_network_policies` toggle. Policies are created in both local and production. Local kindnet accepts the resources but does not enforce them, so local behavior is unchanged.

**Rationale:** avoids a new variable threaded through three modules. Terraform diffs remain symmetric between envs. If local enforcement matters later, swap kind's CNI to Cilium/Calico rather than gating the policy manifests.

### D9. Rollout: staging-cluster dry run, then atomic production apply

**Decision:** provision a scratch UpCloud UKS cluster from the same module with the same config; `tofu apply` the full change; smoke-test login, trigger, ACME renewal, webhook delivery; tear down. Then `tofu apply` atomically against production. Rollback via `tofu state rm` of the NetworkPolicy resources.

**Rationale:** the unknowns at apply time are CNI-specific (Cilium policy evaluation order, label matching for Helm-managed Traefik pods, init-container ordering in the Traefik Helm chart). A scratch cluster surfaces them before production users are affected. Atomic production apply is simpler than stepwise because the staging run has already validated the complete picture.

### D10. SECURITY.md updates are part of this change

**Decision:** `SECURITY.md` is edited in the same PR that adds the NetworkPolicies. R-A3, R-I1, R-I9 move to **Resolved**; R-S4 is re-scoped to "app-layer half remains open".

**Rationale:** leaving stale residual risks in the security doc after their mitigations land erodes the doc's reliability. The doc is meant to be machine-consumable; an AI agent that reads an outdated R-I9 entry might propose redundant or conflicting work.

## Risks / Trade-offs

**R1. Wrong Traefik label breaks forward-auth / ingress.** → Verify via `kubectl get pod -l app.kubernetes.io/name=traefik -n default` on the scratch cluster before finalizing the policy. The Traefik Helm chart v39 uses standard Kubernetes recommended labels.

**R2. Node-local-dns intercepts DNS at `169.254.20.10`.** UpCloud UKS may run node-local-dns as a DaemonSet. → Smoke test DNS resolution on the scratch cluster; if pods cannot resolve, add an egress rule permitting `169.254.20.10/32` on `:53` (which is excluded by our current IMDS-blocking `169.254.0.0/16` carve-out — this is one of two places where an added exception may be needed).

**R3. Traefik plugin init-container ordering.** → Confirm on scratch cluster that the Traefik Helm chart's `deployment.initContainers` runs before the main container and that the shared `emptyDir` is visible in both.

**R4. ConfigMap size near 1 MiB soft limit.** → Current tarball 735 KB (base64 ~978 KB wire). If a future plugin version pushes past 1 MiB, either switch to a Secret (same limit but isolates RBAC), split across two ConfigMaps, or introduce a PVC-backed approach. Unlikely for this plugin.

**R5. GitHub release asset URL changes.** → Release asset URLs are stable; if the repo is ever deleted or renamed, apply will fail fast (http data source 404). Mitigation: document in design that upgrading requires verifying both the URL pattern and the published sha256.

**R6. Stepwise rollback loses integrity of default-deny.** → `tofu state rm` removes the NetworkPolicy resource from state but the k8s object remains until `kubectl delete`. Document the rollback as: `tofu state rm` followed by `kubectl delete networkpolicy <names>` — both steps required to reopen traffic.

**R7. Single-replica deployment during apply.** → The NP change triggers no pod restart by itself (just adds enforcement). The plugin-vendoring half DOES restart Traefik (Helm values change). Plan the production apply during low-traffic window.

**R8. Default-deny is "additive" with existing policies but we have none today.** → No risk from NP interaction (no other policies to conflict with). Future additions should be reviewed against this baseline.

## Migration Plan

1. **Implement change on a branch.**
2. **Provision scratch UpCloud UKS cluster** via a temporary `infrastructure/upcloud-staging/` root (or by pointing the existing upcloud root at a non-production domain).
3. **Apply change atomically on scratch cluster.** Observe Traefik startup logs (plugin loaded from localPlugins?), CoreDNS resolution from app, oauth2-proxy login flow, ACME cert issuance.
4. **Destroy scratch cluster.**
5. **Merge PR to `main`.**
6. **Apply atomically to production** during low-traffic window.
7. **Post-apply verification** (manual smoke test):
   - Sign in via GitHub — tests oauth2-proxy → `github.com` + `api.github.com` egress.
   - Visit `/dashboard` — tests Traefik → app ingress/egress.
   - Trigger a workflow that fetches an external URL — tests app Internet egress.
   - Confirm ACME cert renewal log — tests Traefik → Let's Encrypt.
   - `kubectl exec` into app pod and attempt `curl 169.254.169.254` — expect network unreachable (positive test for IMDS block).
8. **Document rollback**: `tofu state rm kubernetes_network_policy_v1.*` + `kubectl delete networkpolicy --all -n default`.

## Open Questions

- **Traefik pod label exact key.** Expected `app.kubernetes.io/name=traefik`. Will verify with `kubectl` on the scratch cluster before committing the selector. If the chart uses a different label, update the policy selector and this design.
- **Node-local-dns presence.** Unknown for UpCloud UKS 1.34. Will discover on scratch cluster smoke test; documented mitigation available.
- **`externalTrafficPolicy` mode at the UpCloud LoadBalancer.** Default `Cluster` works with our `from: 0.0.0.0/0` Traefik ingress rule; `Local` would also work. Not blocking.
