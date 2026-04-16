## 1. Pre-migration verification

- [x] 1.1 Verify s2-server data write path: `podman run --rm mojatter/s2-server:0.4.1 ls -la /` — determine correct emptyDir mount path (result: `/data`, working dir is `/`)
- [x] 1.2 Download and commit Traefik plugin tarball: `curl -L https://github.com/tuxgal/traefik_inline_response/archive/refs/tags/v0.1.2.tar.gz -o infrastructure/modules/traefik/plugin/plugin-v0.1.2.tar.gz`
- [x] 1.3 Extract 5xx error page HTML from `workflow-engine.tf` heredoc into `infrastructure/templates/error-5xx.html`

## 2. Phase 1 — Structural reshape (no behavior change)

- [x] 2.1 Create `infrastructure/envs/` directory structure: `envs/local/`, `envs/upcloud/cluster/`, `envs/upcloud/persistence/`
- [x] 2.2 Move root TF files to new layout: `local/local.tf` → `envs/local/local.tf`, `upcloud/upcloud.tf` → `envs/upcloud/cluster/upcloud.tf`, `upcloud/persistence/persistence.tf` → `envs/upcloud/persistence/persistence.tf`
- [x] 2.3 Move and update `terraform.tfvars`, `.terraform.lock.hcl`, `.gitignore`, and `local.secrets.auto.tfvars.example` to match new paths
- [x] 2.4 Rename `modules/routing/` → `modules/traefik/` — move `routing.tf` → `traefik.tf`
- [x] 2.5 Rename `modules/s3/` → `modules/object-storage/` (subdirectories `s2/` and `upcloud/` unchanged)
- [x] 2.6 Rename `modules/image/local/` → `modules/image/build/`
- [x] 2.7 Delete `modules/image/registry/` — inline the image string in `envs/upcloud/cluster/upcloud.tf`
- [x] 2.8 Flatten `modules/workflow-engine/` → `modules/app-instance/`: move `modules/app/app.tf` and `modules/oauth2-proxy/oauth2-proxy.tf` up one level, split into `workloads.tf`, `secrets.tf`, `oauth2-locals.tf`, `netpol.tf`, `routes.tf`, `outputs.tf`
- [x] 2.9 Create `modules/baseline/baseline.tf` — namespace creation with PSA `warn` label, default-deny NP per namespace, shared securityContext output locals, shared NP constants output
- [x] 2.10 Create `modules/netpol/` — `variables.tf` + `main.tf` implementing the profile-based NP factory
- [x] 2.11 Create `modules/dns/dynu/` — extract Dynu provider, domain data source, and CNAME resource from `envs/upcloud/cluster/upcloud.tf`
- [x] 2.12 Remove `data.external`, `terraform_data.traefik_plugin_content`, and `.plugin-cache/` directory — replace with `filebase64()` reading committed tarball in `modules/traefik/plugin.tf`
- [x] 2.13 Standardize all workload labels to `app.kubernetes.io/name` + `app.kubernetes.io/instance`
- [x] 2.14 Refactor oauth2-proxy env vars: replace 15 individual `env {}` blocks with `dynamic "env"` over two local maps (`oauth2_env` and `oauth2_secret_env`)
- [x] 2.15 Create `modules/app-instance/routes-chart/` local Helm chart: `Chart.yaml` + `templates/routes.yaml` with IngressRoute and Middleware definitions templated via `{{ .Values }}`
- [x] 2.16 Add `routes.tf` in app-instance: `helm_release` pointing at `routes-chart/` with values for domain, service names, ports, TLS config
- [x] 2.17 Remove IngressRoutes and Middlewares from Traefik `extraObjects` output — delete `traefik_extra_objects` variable/output from traefik module
- [x] 2.18 Update `envs/local/local.tf` root: wire baseline, traefik, cert-manager, app-instance modules with `for_each` over `local.instances` map, pass `error_page_5xx_html` via `file()`
- [x] 2.19 Update `envs/upcloud/cluster/upcloud.tf` root: wire baseline, traefik, cert-manager, app-instance, dns/dynu modules, add `moved {}` block for Dynu DNS `restapi_object`
- [x] 2.20 Update `envs/upcloud/persistence/persistence.tf`: adjust module source paths (`../../modules/object-storage/upcloud`)
- [x] 2.21 Migrate all NPs (app, oauth2, traefik, s2) to use `modules/netpol/` factory calls
- [x] 2.22 Move default-deny NP from app-instance into baseline module (per-namespace via `for_each`)
- [x] 2.23 Update `.gitignore` to remove `.plugin-cache/` entry, add `modules/traefik/plugin/*.tar.gz` tracking (ensure committed, not ignored)
- [x] 2.24 Update CI workflow: change `tofu validate` and `tofu fmt` paths to `infrastructure/envs/` and `infrastructure/envs/upcloud/persistence/`

## 3. Phase 2 — Behavior changes

- [x] 3.1 Add pod + container `security_context` to workflow-engine Deployment (from baseline locals), add emptyDir volume at `/tmp`
- [x] 3.2 Add pod + container `security_context` to oauth2-proxy Deployment (from baseline locals)
- [x] 3.3 Add pod + container `security_context` to s2 Deployment (from baseline locals), add emptyDir volumes at `/data` and `/tmp`
- [x] 3.4 Add explicit container `securityContext` to Traefik Helm values (main container: `allowPrivilegeEscalation=false`, `readOnlyRootFilesystem=true`, `capabilities.drop=[ALL]`)
- [x] 3.5 Add explicit `securityContext` to Traefik init container in Helm values (runAsUser=65532, runAsNonRoot, allowPrivilegeEscalation=false, readOnlyRootFilesystem=true, capabilities.drop=[ALL], seccompProfile=RuntimeDefault)
- [x] 3.6 Move workloads to per-instance namespaces: set `namespace = var.namespace` (from `for_each` key) on all `kubernetes_*` resources in app-instance, set `namespace = "traefik"` on traefik module
- [x] 3.7 Flip baseline PSA label from `warn` to `enforce` on all workload namespaces and `cert-manager` namespace
- [x] 3.8 Add `depends_on = [module.netpol, module.baseline]` to all Deployment resources
- [x] 3.9 Update Dockerfile: `USER nonroot` → `USER 65532`

## 4. Validation

- [x] 4.1 Local env: run `pnpm local:destroy` (old path), then `pnpm local:up` (new path) — verify clean build, all pods running, HTTPS accessible at `https://localhost:8443`
- [x] 4.2 Verify `tofu plan` in `envs/upcloud/cluster/` shows expected changes (K8s resources replaced, Dynu DNS moved, no cluster recreation)
- [x] 4.3 Verify `tofu plan` in `envs/upcloud/persistence/` shows no changes (path move only)
- [x] 4.4 Run `pnpm validate` (lint, format check, type check, tests) — must pass (fixed button type attribute in error-5xx.html)
- [x] 4.5 Run `tofu fmt -check -recursive infrastructure/` — must pass
- [x] 4.6 Update `CLAUDE.md` paths and commands for new directory layout
- [x] 4.7 Update `SECURITY.md §5` to document namespace isolation model, PodSecurity enforcement, and securityContext requirements
- [x] 4.8 Update `openspec/specs/infrastructure/spec.md` to reflect `pnpm local:up`/`local:destroy` script path changes (covered by delta spec in change artifacts; applied at archive)
