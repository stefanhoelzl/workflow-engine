## 1. Plugin vendoring (braided)

- [x] 1.1 Add `locals` block in `modules/workflow-engine/workflow-engine.tf` with `plugin_version = "v0.1.2"` and `plugin_url` computed from the version. (No sha256 pin — see design.md D6a: OpenTofu cannot ergonomically hash binary HTTP responses in-memory, and the workaround's filesystem side effect outweighs the additional protection.)
- [x] 1.2 Declare `data "http" "traefik_plugin_tarball"` pointing at the release asset URL.
- [x] 1.3 Add `required_providers` entry for `hashicorp/http` in the umbrella module if not already transitively available.
- [x] 1.4 Create a `kubernetes_config_map_v1` named `traefik-plugin-inline-response` with `binary_data = { "plugin.tar.gz" = data.http.traefik_plugin_tarball.response_body_base64 }`.
- [x] 1.5 Add init container + volume definitions to `traefik_helm_values`: an init container (busybox or similar) mounting the ConfigMap at `/src` and an `emptyDir` at `/plugins-local`, running `mkdir -p /plugins-local/src/github.com/tuxgal/traefik_inline_response && tar -xzf /src/plugin.tar.gz --strip-components=1 -C /plugins-local/src/github.com/tuxgal/traefik_inline_response`.
- [x] 1.6 Add the same `emptyDir` as a volume mount on the main Traefik container at `/plugins-local` via `additionalVolumeMounts`.
- [x] 1.7 Change `traefik_helm_values.experimental.plugins.inline-response` to `traefik_helm_values.experimental.localPlugins.inline-response` with `moduleName = "github.com/tuxgal/traefik_inline_response"` (drop the `version` field).

## 2. Default-deny baseline NetworkPolicy

- [x] 2.1 In `modules/workflow-engine/workflow-engine.tf`, declare `resource "kubernetes_network_policy_v1" "default_deny"` with `metadata.name = "default-deny"`, `metadata.namespace = "default"`, `spec.pod_selector {}`, `spec.policy_types = ["Ingress", "Egress"]`, and no `ingress`/`egress` blocks.

## 3. App workload NetworkPolicy

- [x] 3.1 In `modules/workflow-engine/modules/app/app.tf`, declare `resource "kubernetes_network_policy_v1" "app"` selecting the app pods by the existing `app = workflow-engine` label.
- [x] 3.2 Add egress rule: `ipBlock` `0.0.0.0/0` with `except = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]`, no port restriction.
- [x] 3.3 Add egress rule: `to` with `namespace_selector { match_labels = { "kubernetes.io/metadata.name" = "kube-system" } }` + `pod_selector { match_labels = { "k8s-app" = "coredns" } }` on UDP `:53` and TCP `:53`.
- [x] 3.4 Add ingress rule: `from` with `pod_selector { match_labels = { "app.kubernetes.io/name" = "traefik" } }` on TCP `:8080`.
- [x] 3.5 Add ingress rule: `from` with `ipBlock = { cidr = "172.24.1.0/24" }` on TCP `:8080` (kubelet probes).

## 4. oauth2-proxy workload NetworkPolicy

- [x] 4.1 In `modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf`, declare `resource "kubernetes_network_policy_v1" "oauth2_proxy"` selecting oauth2-proxy pods by the `app = oauth2-proxy` label.
- [x] 4.2 Add egress rule: same Internet `ipBlock` with private-range `except` (copy from task 3.2 shape).
- [x] 4.3 Add egress rule: CoreDNS on UDP+TCP `:53` (copy from task 3.3 shape).
- [x] 4.4 Add ingress rule: Traefik pods on TCP `:4180`.
- [x] 4.5 Add ingress rule: node CIDR `172.24.1.0/24` on TCP `:4180` for probes.

## 5. Traefik workload NetworkPolicy (via extraObjects)

- [x] 5.1 In `modules/workflow-engine/workflow-engine.tf`, append to the `traefik_extra_objects` output list a `NetworkPolicy` object selecting pods with `app.kubernetes.io/name = traefik`.
- [x] 5.2 Add egress: Internet `ipBlock` with private-range `except`.
- [x] 5.3 Add egress: CoreDNS on UDP+TCP `:53`.
- [x] 5.4 Add egress: `podSelector` app `= workflow-engine` on TCP `:8080`.
- [x] 5.5 Add egress: `podSelector` app `= oauth2-proxy` on TCP `:4180`.
- [x] 5.6 Add ingress: `ipBlock` `0.0.0.0/0` on TCP `:80` and `:443`.
- [x] 5.7 Add ingress: node CIDR `172.24.1.0/24` on Traefik's probe port.
- [x] 5.8 Also append the plugin `ConfigMap` (from task 1.4) to `traefik_extra_objects` if Helm-managed delivery is chosen; otherwise keep it as a separate `kubernetes_config_map_v1` resource in the umbrella.

## 6. SECURITY.md updates

- [x] 6.1 Mark §4 R-A3 as **Resolved** with a short note referencing the NetworkPolicy that closed it.
- [x] 6.2 Mark §5 R-I1 as **Resolved** with a reference to the default-deny + allow-rules.
- [x] 6.3 Mark §5 R-I9 as **Resolved** with a note: "infrastructure half closed via NetworkPolicy; app-layer URL allowlist for `__hostFetch` still outstanding under §2 R-S4".
- [x] 6.4 Re-scope §2 R-S4 title/description to "app-layer URL allowlist" (infrastructure half closed).
- [x] 6.5 Ensure §5 "Production deployment notes" checklist item 1 (NetworkPolicy) is marked done; item 5 (Egress policy) partially done (URL filtering pending).

## 7. Staging-cluster dry run

- [~] 7.1 Provision a scratch UpCloud UKS cluster with the same module config (temporary `upcloud-staging` root or by re-pointing an existing root at a non-production domain). _Skipped — verified directly in production, see §8._
- [~] 7.2 `tofu apply` the full change atomically to the scratch cluster. _Skipped._
- [x] 7.3 Verify with `kubectl get pod -l app.kubernetes.io/name=traefik -n default` that the Traefik label key matches what the policy selectors use; update selectors if not. _Covered by prod verification._
- [x] 7.4 Verify Traefik pod startup logs show `plugin loaded from localPlugins` (or equivalent success path) and no `github.com` fetch attempts.
- [x] 7.5 Smoke-test sign-in (exercises oauth2-proxy → github.com + api.github.com egress).
- [x] 7.6 Smoke-test `/dashboard` (exercises Traefik → app ingress, app → CoreDNS, app → UpCloud S3 egress).
- [x] 7.7 Smoke-test triggering a workflow that fetches an external URL (exercises app → Internet egress).
- [x] 7.8 Smoke-test ACME cert issuance completes (exercises Traefik → Let's Encrypt egress).
- [x] 7.9 `kubectl exec` into app pod, attempt `curl --max-time 3 169.254.169.254` — expect timeout / network unreachable (positive test for IMDS block).
- [~] 7.10 If DNS fails during the smoke test, test whether a `169.254.20.10/32` ingress rule is needed (node-local-dns path); add the rule to the DNS egress allow if so. _N/A — DNS worked._
- [~] 7.11 `tofu destroy` the scratch cluster. _N/A — no scratch cluster._

## 8. Production rollout

- [x] 8.1 Pick a low-traffic window.
- [x] 8.2 Run `tofu plan` and review NetworkPolicy + Traefik Helm diff.
- [x] 8.3 `tofu apply` atomically.
- [x] 8.4 Repeat the smoke-test steps from tasks 7.5–7.9 against production.
- [x] 8.5 Monitor Traefik + app + oauth2-proxy logs for any drop or policy-denied errors for 30 minutes.
- [x] 8.6 Document the rollback procedure in the PR description: `tofu state rm kubernetes_network_policy_v1.*` followed by `kubectl delete networkpolicy --all -n default` to restore pre-change connectivity.

## 9. Validation against spec

- [x] 9.1 Run `pnpm validate` (lint, format, type check, test).
- [x] 9.2 Run `pnpm exec openspec validate harden-pod-network --strict` to confirm the change artifacts are well-formed.
