## 1. Cert-manager module (3a shape)

- [x] 1.1 Rewrite `infrastructure/modules/cert-manager/cert-manager.tf`: delete the `http` data source and `kubernetes_manifest.crd` loop (CRDs come from the Helm chart via `installCRDs=true`)
- [x] 1.2 Delete the `kubernetes_manifest.letsencrypt_prod`, `kubernetes_manifest.selfsigned_bootstrap`, `kubernetes_manifest.selfsigned_ca_cert`, and `kubernetes_manifest.selfsigned_ca_issuer` resources
- [x] 1.3 Keep the `helm_release.cert_manager` but change `installCRDs` set value from `"false"` to `"true"`
- [x] 1.4 Add a `certificate_requests` variable: `list(object({ name = string, namespace = string, secretName = string, dnsNames = list(string) }))`, default `[]`
- [x] 1.5 Synthesize `extraObjects` as a list of YAML-string documents (cert-manager chart format) containing ClusterIssuers, CA Certificate, and leaf Certificates conditional on `enable_*` flags and `certificate_requests`. Single `helm_release` — no second chart needed; cert-manager chart has a first-party `extraObjects` key that runs `tpl` over each YAML string.
- [x] 1.6 Dropped `kubernetes_namespace_v1.cert_manager`; Helm's `create_namespace = true` handles it
- [x] 1.7 Simplified outputs: `helm_release_id` + `active_issuer_name` (computed from enabled flag)

## 2. Workflow-engine module (3a shape)

- [x] 2.1 Deleted `kubernetes_manifest.certificate` resource (Certificate now lives in cert-manager module via its certificate_requests input)
- [x] 2.2 Shrank `tls` variable to `{ secretName }` only
- [x] 2.3 Added `cert_request` output (null when tls is null)
- [x] 2.4 Verified IngressRoute `tls` block uses `{ secretName = var.tls.secretName }` — no change needed
- [x] 2.5 Verified `redirect-to-https` Middleware and port-80 catch-all IngressRoute are still present

## 3. Production root wiring (`infrastructure/upcloud/upcloud.tf`)

- [x] 3.1 Added `certificate_requests = module.workflow_engine.cert_request != null ? [module.workflow_engine.cert_request] : []` to cert_manager module call (compact() only works on lists of strings, so used null-check instead)
- [x] 3.2 Updated `tls` to `{ secretName = "workflow-engine-tls" }`
- [x] 3.3 Removed reference to `module.cert_manager.acme_issuer_name`
- [x] 3.4 Confirmed PVC and ACME helm sets removal from earlier edit persists

## 4. Local root wiring (`infrastructure/local/local.tf`)

- [x] 4.1 Added certificate_requests wiring (null-check form)
- [x] 4.2 Updated tls shape
- [x] 4.3 Removed reference to selfsigned_issuer_name

## 5. Documentation

- [x] 5.1 Removed two-stage bootstrap steps from CLAUDE.md
- [x] 5.2 Removed local two-stage bootstrap note
- [x] 5.3 Added optional `kubectl wait --for=condition=Ready certificate/...` recipe
- [x] 5.4 Added cert-manager chart-version upgrade procedure
- [x] 5.5 Verified SECURITY.md §5 — no `kubernetes_manifest.wait` references; still accurate
- [x] 5.6 Verified no .tfvars references to removed variables

## 6. Spec sync

- [x] 6.1 `pnpm exec openspec validate add-cert-manager --strict` passes
- [x] 6.2 Delta spec accurately reflects implementation (single helm_release with extraObjects, tls shape shrinks, cert_request output added, Certificate ownership moves to cert-manager module)

## 7. Local validation

- [x] 7.1 Run `pnpm infra:destroy` to tear down any existing local env
- [x] 7.2 Run `pnpm infra:up` from clean state; verify `tofu apply` completes successfully in a SINGLE invocation (no `-target` needed). Required two mid-run source fixes: (a) encode extraObjects entries to YAML strings up front to satisfy OpenTofu's strict tuple-type unification; (b) split cert-manager install into two helm_releases (primary + local extras-chart) because cert-manager chart's `extraObjects` can't resolve CR kinds in the same release that installs the CRDs.
- [x] 7.3 `kubectl get certificate -A` — both `selfsigned-ca` (cert-manager ns) and `workflow-engine` (default ns) Certificates are `Ready=True`
- [x] 7.4 `kubectl describe secret workflow-engine-tls -n default` — type `kubernetes.io/tls`, data `ca.crt` 558B, `tls.crt` 839B, `tls.key` 1675B (RSA 2048 default)
- [x] 7.5 `curl -sk https://localhost:8443/livez` returns 200; openssl s_client shows `issuer=CN=selfsigned-ca`
- [x] 7.6 Triggered 5xx via pod delete + curl /webhooks/test (browser-verified) — inline error page renders, no redirect interference
- [ ] 7.7 ~~HTTP→HTTPS redirect check~~ — SKIPPED: local stack only exposes NodePort 30443→websecure on the host; the `web` entrypoint (port 80) is not mapped to a host port. Prod validation will exercise this path via the UpCloud LB's port 80 frontend.

## 8. Production validation (post-merge, pre-traffic)

- [x] 8.1 `tofu plan` reviewed — initial plan showed unexpected 6-destroy set (NetworkPolicies + traefik_plugin ConfigMap) because prod state had been populated from an unmerged `netowkr-policy` git-stash branch. Resolution: rebased cert-manager branch onto origin/main (which included the network-policy work), resolved SECURITY.md conflict, re-planned. Final plan: 2 to add (cert_manager + extras releases), 4 to change (traefik helm, app/oauth2-proxy deployments, DNS CNAME), 1 to destroy (PVC).
- [x] 8.2 `tofu apply` succeeded after several rounds of intervention: (a) tainted `module.workflow_engine.terraform_data.traefik_plugin_fetch` because `.plugin-cache/` was gone on this machine; (b) killed hung apply after PVC destroy blocked Traefik helm update from starting; (c) did `tofu apply -target=module.routing.helm_release.traefik` to update Traefik first, releasing PVC mount; (d) imported orphan `cert_manager_extras` helm release into state after force-unlock rolled back previous apply's state record.
- [x] 8.3 Certificate reached `Ready=True` AFTER the NetworkPolicy fix below; cert-manager self-check had been failing with 504 due to solver-pod ingress blocked by default-deny NetworkPolicy.
- [x] 8.4 Browser confirmed valid Let's Encrypt cert, no warning, on `https://workflow-engine.webredirect.org`.
- [x] 8.5 `curl -sI http://workflow-engine.webredirect.org/` returns `308 Permanent Redirect` (Traefik 3.x `permanent=true` uses 308 per RFC 7538, not 301).
- [x] 8.6 Checked UpCloud console: `traefik-certs` volume was NOT auto-deleted — see §9.2 below (reclaim-policy finding). Operator manually deletes via console / upctl.
- [ ] 8.7 ~~Force cert renewal via `cmctl renew`~~ — SKIPPED. Deferred; will validate renewal path when it naturally fires (~60 days). Design doc risk noted: we no longer have tofu-level fast-fail on issuance errors (traded away in 3a), so renewal failures will need to be caught via cert-manager metrics or a scheduled `kubectl wait` check.

## 9. Mid-apply findings requiring code/spec changes

- [x] 9.1 **NetworkPolicy gap for ACME HTTP-01 solver pods**. The merged-in default-deny NetworkPolicy posture blocks Traefik → solver pods and solver pod → Traefik. Initial symptom: LE challenge request times out with 504 Gateway Timeout after reaching Traefik. Fix split per the per-concern convention: (a) added a 3rd egress rule on `module.routing.kubernetes_network_policy_v1.traefik` allowing egress to pods with `acme.cert-manager.io/http01-solver=true` on TCP/8089; (b) added `module.cert_manager.kubernetes_network_policy_v1.acme_solver_ingress` (for_each per unique `certificate_requests` namespace, gated on `enable_acme`) allowing ingress from Traefik to solver pods on TCP/8089. Re-added the `hashicorp/kubernetes` provider requirement to the cert-manager module since it now owns HCL resources in addition to the helm_release.
- [x] 9.2 **`reclaimPolicy: Retain` on the storage class**. Verified on-cluster: `kubectl get sc upcloud-block-storage-standard` shows `reclaimPolicy: Retain`, contradicting the initial assumption that the CSI driver auto-deletes volumes on PVC removal. Consequence: deleting the `traefik-certs` PVC left the PV in `Released` state and the UpCloud block-storage disk orphaned (still billing). Fix: manual cleanup (`kubectl delete pv <name>`, delete disk via UpCloud console). Spec/proposal migration notes updated to document this reality.
- [x] 9.3 **Traefik helm update scheduling quirk**. When tofu had both a PVC destroy AND a Traefik helm update queued, it started PVC destroy but didn't start Traefik update — PVC destroy then hung for 9+ minutes because the old Traefik pod still mounted it. Workaround: targeted apply of `module.routing.helm_release.traefik` first, then full apply. No code fix needed, but worth noting for future migrations that remove resources still referenced by a workload.
