## 1. New `modules/caddy/`

- [x] 1.1 Create `infrastructure/modules/caddy/` directory with `variables.tf`, `main.tf`, `outputs.tf`, `caddyfile.tpl`
- [x] 1.2 Declare module input variables: `namespace`, `domain`, `upstream_service` (object: `{namespace, name, port}`), `service_type` (default `"LoadBalancer"`), `service_annotations` (map, default `{}`), `acme_email` (string, optional — empty triggers `tls internal`), `image_tag` (default a pinned Caddy LTS), `pvc_size` (default `"10Gi"`), `pvc_storage_class` (optional), `node_port_https` (number, optional, used when `service_type=NodePort`), `baseline` (object passed-through), `namespace_ready` (any, dependency token)
- [x] 1.3 Render the `kubernetes_namespace_v1` only if not pre-created by baseline (keep symmetry with current Traefik module — caller decides)
- [x] 1.4 Render the `kubernetes_service_account_v1` with `automount_service_account_token = false`
- [x] 1.5 Render the `kubernetes_config_map_v1` carrying `Caddyfile` templated from `caddyfile.tpl`. Template SHALL inject domain, upstream service ref, and either `acme_email` (HTTP-01 path) or `tls internal` (local path). Include `admin off` at the global level.
- [x] 1.6 Render the `kubernetes_persistent_volume_claim_v1` for `/data` (ACME storage). Use `var.pvc_storage_class` if set; otherwise default storage class.
- [x] 1.7 Render the `kubernetes_deployment_v1`: 1 replica; `app.kubernetes.io/name=caddy` + `app.kubernetes.io/instance=<namespace>` labels; container image `caddy:<tag>`; mount Caddyfile at `/etc/caddy/Caddyfile` (read-only) and PVC at `/data`; `emptyDir` volumes for `/config` and `/var/log`; pod-level `securityContext` (runAsNonRoot=true, runAsUser=65532, runAsGroup=65532, fsGroup=65532, fsGroupChangePolicy=OnRootMismatch, seccompProfile=RuntimeDefault); container-level `securityContext` (allowPrivilegeEscalation=false, readOnlyRootFilesystem=true, capabilities.drop=[ALL]); `livenessProbe` and `readinessProbe` against `:80` `/` (or Caddy's `/metrics` if exposed)
- [x] 1.8 Render the `kubernetes_service_v1` with `type = var.service_type`. Apply `var.service_annotations` (cluster env passes the UpCloud LB annotation; local env passes none and sets `node_port_https`). Expose ports `:80` and `:443`.
- [x] 1.9 Render the inline `kubernetes_network_policy_v1` for the Caddy pod per `Requirement: Caddy network policy` (ingress from LB CIDRs + node CIDR on `:80`/`:443`; egress to upstream Service on `:8080`, CoreDNS on `:53`, public internet on `:80`/`:443` except RFC1918+link-local)
- [x] 1.10 Module outputs: `service_name`, `service_namespace`, `service_port_https`, `helm_release_id`-shaped readiness token (or a `null_resource` `triggers` carrying the Deployment's metadata.uid for downstream `depends_on`)

## 2. Inline NetworkPolicy in `modules/app-instance/`

- [x] 2.1 In `modules/app-instance/netpol.tf` (existing) replace the `module "netpol" {...}` invocation with a direct `kubernetes_network_policy_v1` resource matching the `App pod NetworkPolicy contract` requirement
- [x] 2.2 Ingress rules: from pods in the Caddy namespace (read `var.caddy_namespace` — new input variable) on `:8080`; from `var.baseline.node_cidr` on `:8080`
- [x] 2.3 Egress rules: to CoreDNS (read `var.baseline.coredns_selector` — keep this baseline output until `app-instance` is the only consumer); to `0.0.0.0/0` on TCP `:80`/`:443` and UDP/TCP wide ranges except `var.baseline.rfc1918_except`; conditionally (when `var.local_deployment`) to the S2 Service on `:9000`
- [x] 2.4 Add `caddy_namespace` input variable to `modules/app-instance/variables.tf`; thread it from each env's composition root
- [x] 2.5 Remove all `active_issuer_name`, `cert_manager_ready`, and Certificate-related inputs from `variables.tf`
- [x] 2.6 Remove the `helm_release "routes"` block and the entire `modules/app-instance/routes-chart/` directory

## 3. `envs/cluster/` rewrite

- [x] 3.1 Delete the `helm` provider block from `cluster.tf`
- [x] 3.2 Delete `module "traefik"` and `module "cert_manager"` invocations
- [x] 3.3 Add `module "caddy"` with `service_type="LoadBalancer"` and the existing UpCloud LB annotation; pass `acme_email = var.acme_email`
- [x] 3.4 Replace the `data "http" "traefik_lb"` block + the `local.traefik_lb_hostname` derivation with a single `data "upcloud_loadbalancer" "this"` (or equivalent) keyed by the `ccm_cluster_id` label. Drop the `hashicorp/http` provider declaration.
- [x] 3.5 Update `outputs.tf`: rename `lb_hostname` source; remove `active_issuer_name`; add `caddy_namespace = "caddy"`; ensure `baseline` output still contains the fields downstream `app-instance` consumes (re-evaluate `rfc1918_except` and `coredns_selector` — keep until app-instance no longer needs them)
- [x] 3.6 Update `module "baseline"` to pass `namespaces = ["caddy"]` (replacing `["traefik"]`)

## 4. `envs/prod/` and `envs/staging/` rewrites

- [x] 4.1 Delete the `helm` provider block from `prod.tf` and `staging.tf`
- [x] 4.2 Delete `data.terraform_remote_state.cluster.outputs.active_issuer_name` references; pass `caddy_namespace = data.terraform_remote_state.cluster.outputs.caddy_namespace` to `module "app"`
- [x] 4.3 Remove any `kubernetes_manifest "certificate"` resources (if present at env scope)
- [x] 4.4 Verify Dynu CNAME continues to point at `data.terraform_remote_state.cluster.outputs.lb_hostname` (now sourced from the upcloud provider)
- [x] 4.5 Confirm `tofu validate` passes in both envs

## 5. `envs/local/` rewrite

- [x] 5.1 Delete the `helm` provider block from `local.tf`
- [x] 5.2 Delete `module "traefik"` and `module "cert_manager"` invocations
- [x] 5.3 Add `module "caddy"` with `service_type="NodePort"`, `node_port_https=30443`, and `acme_email=""` (triggers the `tls internal` Caddyfile path); namespace can co-locate with the app namespace or be a dedicated `caddy` namespace — pick based on baseline-input shape
- [x] 5.4 Update `module "baseline"` to remove `traefik` from the namespace list; replace with `caddy` (or co-located namespace)
- [x] 5.5 Pass `caddy_namespace` into `module "app_instance"`
- [x] 5.6 Confirm `pnpm local:up:build` (operator-run) brings up the kind cluster, builds the app image, deploys Caddy with `tls internal`, and reaches `https://<domain>:<https_port>` (browser self-signed warning expected and accepted)

## 6. Module deletions

- [x] 6.1 Delete `infrastructure/modules/traefik/` (entire directory)
- [x] 6.2 Delete `infrastructure/modules/cert-manager/` (entire directory)
- [x] 6.3 Delete `infrastructure/modules/netpol/` (entire directory)
- [x] 6.4 Delete `infrastructure/modules/app-instance/routes-chart/` (entire subdirectory)
- [x] 6.5 Delete `infrastructure/templates/error-5xx.html` (if present at infrastructure scope)
- [x] 6.6 Delete the committed Traefik plugin tarball `modules/traefik/plugin/plugin-<version>.tar.gz` if not already removed by 6.1
- [x] 6.7 Run `tofu fmt -recursive infrastructure/` and confirm no formatting drift

## 7. CI + validation

- [x] 7.1 Run `tofu init -backend=false && tofu validate` in `envs/cluster/`, `envs/prod/`, `envs/staging/`, `envs/local/`, `envs/persistence/` — all SHALL pass
- [x] 7.2 Run `tofu fmt -check -recursive infrastructure/` — SHALL pass
- [x] 7.3 Confirm `.github/workflows/plan-infra.yml` continues to plan `cluster` and `persistence` and that no helm-provider download breaks CI
- [x] 7.4 Run `pnpm validate` — SHALL pass (no app code changes expected; this is a sanity check)

## 8. Local cluster smoke (operator-run, before merge)

- [ ] 8.1 `pnpm local:up:build` — verify clean apply on a fresh kind cluster
- [ ] 8.2 `kubectl get pods -A` — confirm Caddy pod ready, no Traefik or cert-manager pods exist
- [ ] 8.3 `curl -k https://<local-domain>:<https_port>/livez` — returns `200 OK`
- [ ] 8.4 `curl -k https://<local-domain>:<https_port>/dashboard` — returns the dashboard HTML with full app-set security headers
- [ ] 8.5 `kubectl logs deploy/caddy -n <caddy-ns>` — confirms `tls internal` log line, no ACME attempts
- [ ] 8.6 `kubectl get networkpolicies -A` — confirm exactly: per-namespace `default-deny` (from baseline), inline app-pod allowlist, inline Caddy-pod allowlist; no acme-solver NP, no factory-generated NPs
- [ ] 8.7 Trigger an HTTP-trigger workflow end-to-end (curl → app → action sandbox → S2 persistence → archive) and confirm it succeeds
- [ ] 8.8 `pnpm local:destroy` — confirm clean teardown

## 9. Cluster smoke (human, prod/staging operator-run during plan-gate apply)

- [ ] 9.1 Operator: `cd infrastructure/envs/cluster && tofu plan` — review Caddy create + Traefik destroy + cert-manager destroy; verify Caddy LoadBalancer Service is created in the same plan with the existing UpCloud annotation
- [ ] 9.2 Operator: `tofu apply` — UpCloud allocates a new LB hostname for Caddy; old Traefik LB is released
- [ ] 9.3 Operator: `cd ../prod && tofu plan && tofu apply` — review NetworkPolicy inlining, Certificate removal, IngressRoute removal; apply
- [ ] 9.4 Operator: `cd ../staging && tofu plan && tofu apply` — same as prod
- [ ] 9.5 Operator: verify `curl -I https://workflow-engine.webredirect.org` returns `200` with HSTS, CSP, and a publicly-trusted LE certificate
- [ ] 9.6 Operator: `kubectl logs deploy/caddy -n caddy | grep "certificate obtained"` confirms ACME success
- [ ] 9.7 Operator: verify Dynu CNAME for prod and staging domains points at the new Caddy LB hostname

## 10. Documentation updates

- [x] 10.1 `CLAUDE.md` `## Infrastructure (OpenTofu + kind)` section: drop Traefik/cert-manager mentions; document Caddy as the routing layer
- [x] 10.2 `CLAUDE.md` `## Dev verification` section: rewrite the "Escalate to `pnpm local:up:build`" trigger list — remove `cert-manager`, `Helm values`; keep `infrastructure/`, `NetworkPolicy`, `K8s manifests`, `secure-headers.ts`
- [x] 10.3 `docs/infrastructure.md`: rewrite the prod/staging operator runbook around Caddy + HTTP-01 ACME + the upcloud provider LB data source; add the new operator apply order from `design.md` D7
- [x] 10.4 `docs/dev-probes.md`: drop Traefik-specific probes (e.g., IngressRoute discovery, Traefik dashboard); add Caddy probes if any (limited because admin endpoint is off)
- [x] 10.5 `SECURITY.md`: grep for `traefik`, `cert-manager`, `IngressRoute`, `Middleware`, `forward-auth`, `oauth2-proxy` — replace or delete dangling references; ensure §5 still describes the threat model accurately (default-deny + app-pod allowlist + Caddy-pod allowlist as defence-in-depth)
- [x] 10.6 `openspec/project.md`: update the "Infrastructure" tech-stack line — replace `Traefik (Helm + IngressRoute CRDs)` with `Caddy (raw kubernetes_manifest, built-in ACME)`; remove `oauth2-proxy` reference if any remains

## 11. Final spec archival

- [ ] 11.1 After implementation lands and is validated in prod/staging, run `pnpm exec openspec archive simplify-cluster-stack`
- [ ] 11.2 Confirm `openspec/specs/network-policy-profiles/` directory is removed during archival
- [ ] 11.3 Confirm `openspec/specs/infrastructure/spec.md` reflects the merged delta (REMOVED requirements gone; MODIFIED requirements updated; ADDED requirements present)
- [ ] 11.4 Confirm `openspec/specs/reverse-proxy/spec.md` is unchanged (still empty per `opentofu-dev` precedent)
