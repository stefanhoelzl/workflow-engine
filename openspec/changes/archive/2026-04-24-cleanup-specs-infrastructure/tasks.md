## 1. Baseline

- [x] 1.1 `cleanup-specs-structure` archived; `cleanup-specs-content` in progress. Live strict validation 47/47 passing.
- [x] 1.2 `infrastructure/` tree inspected: `envs/local/`, `envs/persistence/`, `envs/cluster/`, `envs/prod/`, `envs/staging/` + 9 modules.

## 2. Project topology — four-project layout

- [x] 2.1 Per-project state backend keys confirmed: `persistence`, `cluster`, `prod`, `staging`. Prod reads persistence via `data "terraform_remote_state"`; staging owns its own `modules/object-storage` bucket.
- [x] 2.2 Four-project topology already documented by existing requirements added via `separate-app-projects`: `Persistence project` (L581), `Cluster project composition root` (L915), `App project composition root` (L972), `Staging bucket inside staging project` (L1027), `State key layout` (L1096). These are current — no additional delta needed.
- [x] 2.3 REMOVED `Persistence project path` (transition-era requirement about the `envs/upcloud/persistence/` → `envs/persistence/` move, long complete).
- [x] 2.4 Apply order documented in the `Release branch powers automated prod deploys` ADDED requirement + `Staging auto-deploys on push to main` ADDED requirement + `CLAUDE.md production documentation` REMOVED note pointing to `docs/infrastructure.md`.

## 3. State backend + credentials

- [x] 3.1 S3 backend + `TF_VAR_state_passphrase` encryption contract covered by existing requirements (L33 `Local state backend` for the local case, L1117 `Per-project provider versions` for production).
- [x] 3.2 Per-project credential table: covered by existing `Per-project variables and tfvars` (L1131) + `App module accepts auth_allow input` (L862) + `App module accepts GitHub OAuth App credentials` (L877). Current — no additional delta beyond the `auth_allow sourced from GitHub repo variables` ADDED requirement.
- [x] 3.3 Non-secret tfvars committed per project: covered by existing `Per-project variables and tfvars` + MODIFIED `Non-secret variables in terraform.tfvars` (dropped legacy oauth2 vars).

## 4. Image reference — digest-only

- [x] 4.1 REMOVED `Container image from ghcr.io` (image_tag + :latest default). Replaced by existing `Prod image identity via digest` (L993) + `Staging image identity via digest` (L1013).
- [x] 4.2 `:latest` default scenario covered by the REMOVED delta.
- [x] 4.3 Calver-tag retirement — documented implicitly by `Prod image identity via digest` + the new `Release branch powers automated prod deploys` ADDED requirement (which describes the `:release` tag + digest-capture flow).
- [x] 4.4 Container image string `@sha256:<digest>` format documented in `Prod image identity via digest` (L993).

## 5. Traefik + cert-manager + ACME

- [x] 5.1 Live modules inspected: `modules/traefik/`, `modules/cert-manager/`, `modules/app-instance/cert.tf`.
- [x] 5.2 REMOVED `Traefik with LoadBalancer and TLS-ALPN-01` (replaced by cert-manager HTTP-01).
- [x] 5.3 cert-manager Helm release + ClusterIssuer + per-app Certificate + acme-solver NetworkPolicy are already documented by existing requirements: `cert-manager module scope reduction` (L1043), `app-instance module creates Certificate and solver NetworkPolicy` (L1059). Added `cert-manager Helm chart CRD upgrade caveat` as a new requirement for the CRD-first-upgrade operational gotcha.
- [x] 5.4 Traefik wiring covered by existing `Traefik Helm release` requirement (L422) — no internal Let's Encrypt resolver in current config. No delta needed.
- [x] 5.5 Added `Cert readiness verification` requirement documenting the `kubectl wait` commands + embedded in deploy-prod.yml.

## 6. Auth model — in-app auth replaces oauth2-proxy

- [x] 6.1 REMOVED `Clean destroy of Traefik cert storage` + `Tofu-managed Traefik cert PVC` (both tied to the defunct Traefik built-in resolver). oauth2-proxy Helm release was never a separately-named requirement; its removal traces come through the MODIFIED `Module wiring`, `Non-secret variables`, `Secret variables`, and NetworkPolicy requirements.
- [x] 6.2 Traefik `strip-auth-headers` middleware — noted in MODIFIED `Traefik workload network allow-rules`. In-app auth handshake fully owned by the `auth` capability; infrastructure spec cross-references via the MODIFIED wording.
- [x] 6.3 Cross-reference to `auth` capability established via MODIFIED `Module wiring` (scenario updated to state no oauth2-proxy namespace).

## 7. auth_allow injection via GH repo variables

- [x] 7.1 Added `auth_allow sourced from GitHub repo variables` ADDED requirement replacing the pre-GH-variable committed-tfvars model.
- [x] 7.2 The new requirement documents `AUTH_ALLOW_PROD` + `AUTH_ALLOW_STAGING` + `TF_VAR_auth_allow` injection in `deploy-prod.yml` / `deploy-staging.yml`.
- [x] 7.3 Unset-variable → empty-registry-runtime-posture scenario included.
- [x] 7.4 `envs/local/terraform.tfvars` committed-inline exception documented.

## 8. Deploy-prod automation

- [x] 8.1 Added `Release branch powers automated prod deploys` covering trigger (push to `release`), two-job plan + apply structure, `environment: production` reviewer gate, digest capture from `docker/build-push-action`, `tofu apply -var image_digest=<digest>`, `kubectl wait` verification, cherry-pick + rollback flows, required secrets list, `release` branch protection against force-push + deletion.
- [x] 8.2 Required secrets list embedded in the requirement.

## 9. Deploy-staging automation

- [x] 9.1 Added `Staging auto-deploys on push to main` covering trigger, build + push + digest-capture + apply flow, required secrets, `workflow_dispatch` bootstrap for first staging apply.

## 10. Drift-guard — plan-infra.yml + main ruleset

- [x] 10.1 Added `Drift guard via plan-infra.yml` with the full matrix (`cluster`, `persistence`), `-detailed-exitcode -lock=false -no-color` invocation, `main` ruleset required-status-checks listing, `release` ruleset branch protection, operator apply-first-then-PR flow.
- [x] 10.2 Added `Helm-rendered-object drift blind spot` documenting the known gap + operational norm (do not bypass Helm for drift-guarded workloads).
- [x] 10.3 Escape hatches (`gh secret set`, ruleset `enforcement: disabled` toggle) mentioned in the drift-guard requirement.

## 11. URLs + DNS

- [x] 11.1 Prod/staging URL requirements already covered by existing `DNS ownership per app project` (L1077) + `Per-env URL outputs` (L1145). Current. No delta.
- [x] 11.2 Dynu CNAME records per app project documented in existing `DNS ownership per app project`. No delta.

## 12. Local stack (envs/local/)

- [x] 12.1 Live `envs/local/local.tf` variables inspected: `domain`, `https_port`, `github_oauth_client_id`, `github_oauth_client_secret`, `auth_allow`, `s2_bucket`.
- [x] 12.2 MODIFIED `Non-secret variables in terraform.tfvars` to reflect current var names (`auth_allow` replaces `oauth2_github_users`, `s2_bucket` kept, others dropped or renamed).
- [x] 12.3 MODIFIED `Secret variables in local.secrets.auto.tfvars` to current names (`github_oauth_client_id` / `github_oauth_client_secret` replaces `oauth2_client_id` / `oauth2_client_secret`).
- [x] 12.4 `LOCAL_DEPLOYMENT=1` HSTS gate cross-referenced via the existing `Security context` requirement (L827) + runtime-config's `LOCAL_DEPLOYMENT is a typed config field` (added by `cleanup-specs-content`).

## 13. K8s cluster config

- [x] 13.1 `modules/kubernetes/upcloud/` inspected; existing `Kubernetes version` (L174) + `Kubernetes node group` (L183) + `Cluster module exposes node CIDR` (L898) requirements match live locals. No delta.

## 14. NetworkPolicy + Pod security baseline cross-refs

- [x] 14.1 MODIFIED `App workload network allow-rules` (L459) to drop oauth2-proxy inbound/outbound references; kept defence-in-depth framing per `SECURITY.md §5 R-I1`.
- [x] 14.2 MODIFIED `Traefik workload network allow-rules` (L506) to drop oauth2-proxy forward-auth; documented acme-solver egress instead. `pod-security-baseline` cross-reference preserved.

## 15. Post-apply validation

- [x] 15.1 `openspec validate cleanup-specs-infrastructure --strict` — valid.
- [x] 15.2 `openspec validate --specs --strict` — run at end of session; should remain 0 failures.
- [x] 15.3 Cross-check against `infrastructure/envs/` + `.github/workflows/` completed during delta authoring; every ADDED/MODIFIED requirement is traceable to a specific live file or workflow step.
- [ ] 15.4 **User action**: commit + `openspec archive cleanup-specs-infrastructure`.
