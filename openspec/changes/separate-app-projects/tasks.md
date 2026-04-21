## 1. Module refactors (code-only, no live changes)

- [x] 1.1 `modules/kubernetes/upcloud/upcloud.tf`: introduce `locals.node_cidr = "172.24.1.0/24"`; change `upcloud_network.this.ip_network.address` to reference `local.node_cidr`; add `output "node_cidr" { value = local.node_cidr }`.
- [x] 1.2 `modules/cert-manager/cert-manager.tf`: delete the `variable "certificate_requests"` block; delete `local.leaf_yaml`; delete `kubernetes_network_policy_v1.acme_solver_ingress`; retain `helm_release "cert_manager_extras"` but strip leaf-cert rendering from its values (keep ACME ClusterIssuer + selfsigned bootstrap/CA chain); retain `output "active_issuer_name"`.
- [x] 1.3 `modules/cert-manager/extras-chart/`: keep the directory — it now renders issuers only (ACME + selfsigned bootstrap/CA), no leaf certs.
- [x] 1.4 `modules/app-instance/variables.tf`: add `variable "active_issuer_name" { type = string, default = null }`; keep `variable "tls"` as-is.
- [x] 1.5 `modules/app-instance/`: extend the routes-chart with a new `templates/certificate.yaml` rendering a `cert-manager.io/v1` Certificate conditional on `{{ .Values.tlsSecretName }}` AND `{{ .Values.certIssuerName }}`; extend `routes.tf`'s `helm_release.routes` values with `certIssuerName = var.active_issuer_name`. Add `modules/app-instance/netpol.tf` (or a new `cert.tf`) with a plain `kubernetes_network_policy_v1 "acme_solver_ingress"` in `var.namespace` allowing Traefik → acme-solver:8089.
- [x] 1.6 `modules/app-instance/outputs.tf`: remove the `cert_request` output (no longer consumed anywhere).
- [x] 1.7 `modules/dns/dynu/`: verify the module is unchanged; it already accepts `domain`, `target_hostname`, `api_key` and is fit for per-app use.
- [x] 1.8 `modules/object-storage/upcloud/`: verify the module accepts `service_uuid`, `endpoint`, `bucket_name` and can be instantiated from any project (no implicit persistence coupling).
- [x] 1.9 Run `tofu fmt -recursive infrastructure/modules/`.
- [x] 1.10 Update `openspec/specs/infrastructure/spec.md` for the `node_cidr` source-of-truth move (implementation-level) and any stale references to `modules/cert-manager` internals. (Note: bulk of the infra spec delta is applied at archive time from the change's spec delta.)

## 1a. Local env follow-through

- [x] 1a.1 `infrastructure/envs/local/local.tf`: remove the `certificate_requests = [...]` argument from the `module "cert_manager"` call; add `active_issuer_name = module.cert_manager.active_issuer_name` to each `module "app_instance"` call.
- [ ] 1a.2 `pnpm local:up` (smoke): verify the local env reaches the usual readiness state so the refactored modules are exercised end-to-end before live prod work.

## 2. Env: persistence relocation

- [x] 2.1 `git mv infrastructure/envs/upcloud/persistence/ infrastructure/envs/persistence/`.
- [x] 2.2 Update module `source` paths inside `envs/persistence/persistence.tf` from `../../../modules/...` to `../../modules/...`.
- [ ] 2.3 `cd infrastructure/envs/persistence && tofu init && tofu plan` — MUST show no drift. (Requires operator creds — run prior to migration window.)

## 3. Env: new cluster project

- [x] 3.1 Create `infrastructure/envs/cluster/` with `upcloud.tf` containing: `terraform {}` block (providers + S3 backend with `key = "cluster"` + encryption); variables for `state_passphrase`, `upcloud_token`, `acme_email`; `provider "upcloud"`; `module "cluster"` (kubernetes/upcloud); `provider "kubernetes"` + `provider "helm"` wired to cluster outputs; `module "baseline"` with `namespaces = ["traefik"]`, `node_cidr = module.cluster.node_cidr`; `module "traefik"` (unchanged wiring); `module "cert_manager"` (enable_acme only, no certificate_requests); `data "http" "traefik_lb"` + `local.traefik_lb_hostname`; outputs listed in 3.2.
- [x] 3.2 Add `infrastructure/envs/cluster/outputs.tf` with outputs: `cluster_id`, `lb_hostname`, `active_issuer_name`, `node_cidr`, `baseline` (object bundle of constants).
- [x] 3.3 Add `infrastructure/envs/cluster/terraform.tfvars` with `acme_email = "..."`. No secrets.
- [x] 3.4 `cd infrastructure/envs/cluster && tofu init && tofu validate`.

## 4. Env: new prod project

- [x] 4.1 Create `infrastructure/envs/prod/` with `main.tf` containing: `terraform {}` block (S3 backend `key = "prod"`, encryption, providers); variables for `state_passphrase`, `upcloud_token`, `dynu_api_key`, `oauth2_client_id`, `oauth2_client_secret`, `domain`, `oauth2_github_users`, `image_tag`; `data "terraform_remote_state" "cluster"` and `data "terraform_remote_state" "persistence"`; `ephemeral "upcloud_kubernetes_cluster" "this"` keyed by cluster_id; `provider "kubernetes"` + `provider "helm"` from ephemeral; `module "baseline"` with `namespaces = ["prod"]`, `node_cidr = data.terraform_remote_state.cluster.outputs.node_cidr`; `module "app"` (app-instance) with `active_issuer_name = data.terraform_remote_state.cluster.outputs.active_issuer_name`, image/image_hash from `var.image_tag`; `module "dns"` (dns/dynu) for the prod domain; `output "url"`.
- [x] 4.2 Add `infrastructure/envs/prod/terraform.tfvars` with `domain = "workflow-engine.webredirect.org"`, `oauth2_github_users = "..."`, `image_tag = "..."` (current prod tag).
- [x] 4.3 `cd infrastructure/envs/prod && tofu init && tofu validate`.

## 5. Env: new staging project

- [x] 5.1 Create `infrastructure/envs/staging/` with `main.tf` containing: `terraform {}` block (S3 backend `key = "staging"`, encryption, providers); variables for `state_passphrase`, `upcloud_token`, `dynu_api_key`, `oauth2_client_id`, `oauth2_client_secret`, `domain`, `oauth2_github_users`, `service_uuid`, `service_endpoint`, `bucket_name`, `image_digest`; `data "terraform_remote_state" "cluster"`; `ephemeral "upcloud_kubernetes_cluster" "this"` keyed by cluster_id; `provider "kubernetes"` + `provider "helm"` from ephemeral; `module "bucket"` (object-storage/upcloud); `module "baseline"` with `namespaces = ["staging"]`, `node_cidr` from cluster remote state; `module "app"` (app-instance) with image = `"ghcr.io/.../@${var.image_digest}"`, `image_hash = var.image_digest`; `module "dns"` for `staging.workflow-engine.webredirect.org`; `output "url"`.
- [x] 5.2 Add `infrastructure/envs/staging/terraform.tfvars` with `domain = "staging.workflow-engine.webredirect.org"`, `oauth2_github_users`, `service_uuid`, `service_endpoint`, `bucket_name = "workflow-engine-staging"`. No `image_digest` default — supplied at apply time.
- [x] 5.3 `cd infrastructure/envs/staging && tofu init && tofu validate` (with `-var image_digest=sha256:...` stub for validate, or omit validate if it requires no var resolution).

## 6. CI workflow: staging deploy

- [x] 6.1 Create `.github/workflows/deploy-staging.yml`: trigger on `push` to `main` and on `workflow_dispatch`; single job; `permissions: contents: read, packages: write`; checkout → `docker/login-action` → `docker/setup-buildx-action` → `docker/build-push-action@v7` (id: build) with `push=true`, `tags=ghcr.io/stefanhoelzl/workflow-engine:main`; `hashicorp/setup-terraform@v3` (or opentofu setup action); `tofu init && tofu apply -auto-approve -var image_digest=${{ steps.build.outputs.digest }}` in `infrastructure/envs/staging/`; `env:` block pulls from repo secrets. Add `concurrency: { group: tofu-staging, cancel-in-progress: false }`.
- [ ] 6.2 Configure repo secrets via `gh secret set` or web UI: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `TF_VAR_OAUTH2_CLIENT_ID`, `TF_VAR_OAUTH2_CLIENT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. (Out-of-repo step — document in CLAUDE.md upgrade note.)
- [x] 6.3 Update `.github/workflows/ci.yml` and `package.json` `validate` script to cover the five env projects; drop references to `envs/upcloud/...`.

## 7. CLAUDE.md updates

- [x] 7.1 Rewrite the "Production (OpenTofu + UpCloud)" section for the four-project layout. Include: prerequisites, per-project env-var matrix (table), non-secret tfvars per project, one-time setup (Object Storage instance, bucket, two GitHub OAuth Apps, Dynu domain), apply order (persistence → cluster → prod → staging), operator vs CI-driven deploy distinction, cert wait commands per env, cert-manager chart upgrade note (unchanged), production URLs.
- [x] 7.2 Add an Upgrade Note to "Upgrade notes" section under the name **separate-app-projects**, describing the destroy+rebuild migration (Reading A) with the exact operator commands.

## 8. External prep (off-repo, document in upgrade note)

- [x] 8.1 Register a second GitHub OAuth App for staging with callback URL `https://staging.workflow-engine.webredirect.org/oauth2/callback`. Capture client_id + secret.
- [x] 8.2 In UpCloud, verify the shared `upcloud/token` already has the required scopes (K8s read + Object Storage + load-balancer read). All four verification curls returned data.
- [x] 8.3 Configure the GHA repo secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `GH_APP_CLIENT_ID_STAGING`, `GH_APP_CLIENT_SECRET_STAGING`). Workflow updated to read the two renamed OAuth secrets.
- [x] 8.4 Reduce the Dynu CNAME TTL for the prod domain to 60s (to shrink client-side cache window during cut-over). Plan migration window ~24h later.

## 9. One-time migration (destructive, downtime ~20-25 min)

- [ ] 9.1 Confirm persistence project path move from step 2 is committed and `tofu plan` shows no drift.
- [ ] 9.2 `cd infrastructure/envs/upcloud/cluster && tofu destroy` — destroys K8s cluster, Traefik, cert-manager, prod app, Dynu record. Downtime begins.
- [ ] 9.3 `rm -rf infrastructure/envs/upcloud/` (only `persistence/` was there before step 2; now the dir is empty of project code).
- [ ] 9.4 Delete S3 object `tofu-state/upcloud` via UpCloud Object Storage UI or `aws s3 rm s3://tofu-state/upcloud --endpoint-url=<endpoint>`.
- [ ] 9.5 `cd infrastructure/envs/cluster && tofu apply` — creates new cluster, Traefik, cert-manager, ClusterIssuer. Duration ~12-17 min.
- [ ] 9.6 `cd infrastructure/envs/prod && tofu apply` — creates prod namespace, certificate, app, DNS. Wait for cert (`kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m`). Verify `https://workflow-engine.webredirect.org` serves traffic. Downtime ends.
- [ ] 9.7 Trigger the staging deploy workflow via `workflow_dispatch` to produce a bootstrap digest. Capture the digest from the action logs. Run `tofu apply envs/staging/ -var image_digest=sha256:...` locally to create initial staging state.
- [ ] 9.8 Wait for staging cert (`kubectl wait --for=condition=Ready certificate/staging-workflow-engine -n staging --timeout=5m`). Verify `https://staging.workflow-engine.webredirect.org` serves traffic.
- [ ] 9.9 Push a trivial commit to `main` and confirm the staging deploy workflow runs end-to-end without operator action, including a successful digest-driven pod rollout.

## 10. Verification and cleanup

- [ ] 10.1 Revert Dynu TTL from 60s back to 300s for the prod CNAME after ~24h of stable operation.
- [ ] 10.2 Delete the rollback branch (if created during pre-migration) once staging + prod have been stable for ~1 week.
- [ ] 10.3 Run `pnpm validate` locally; fix any format/lint regressions introduced by the module refactors.
- [ ] 10.4 Verify `tofu plan` is clean in all four projects (no pending drift).
- [ ] 10.5 Confirm CLAUDE.md Upgrade Notes entry is accurate vs. what was actually done during migration; fix any discrepancies.
