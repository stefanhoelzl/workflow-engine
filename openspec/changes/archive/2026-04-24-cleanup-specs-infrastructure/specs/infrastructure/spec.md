## ADDED Requirements

### Requirement: Drift guard via plan-infra.yml

The repository SHALL maintain `.github/workflows/plan-infra.yml` running on every pull request targeting `main`. The workflow SHALL execute `tofu plan -detailed-exitcode -lock=false -no-color` against each operator-driven project in a matrix strategy. The matrix SHALL currently include `cluster` and `persistence`. A non-empty plan from any matrix entry SHALL fail the corresponding check; the check name SHALL be `plan (<project>)`.

The `main` branch ruleset SHALL declare `plan (cluster)` and `plan (persistence)` in its `required_status_checks` list alongside `ci` and any other required checks. `bypass_actors` SHALL be `[]` — no per-PR admin bypass. The `strict_required_status_checks_policy` SHALL be `true` so a PR must be up-to-date with `main` before merging.

The `release` branch SHALL have its own protection ruleset preventing force-push and deletion (not covered by the `main` ruleset since `release` is the prod deployment source).

Operator flow for drift-guarded projects (`envs/cluster/` + `envs/persistence/`):

1. `git pull --rebase origin main` — required before local `tofu apply` to avoid reverting another operator's in-flight work.
2. Edit `.tf` files locally.
3. `tofu -chdir=infrastructure/envs/<project> apply` — updates state to match the edited config.
4. Commit edits, push, open PR to `main`.
5. `plan (cluster)` and `plan (persistence)` both report empty plans → green → merge.

#### Scenario: Empty plan passes the check

- **GIVEN** a PR that changed only comments in `envs/cluster/*.tf`
- **WHEN** `plan-infra.yml` runs
- **THEN** `tofu plan -detailed-exitcode` SHALL return exit code 0 for cluster
- **AND** the `plan (cluster)` check SHALL pass

#### Scenario: Non-empty plan blocks merge

- **GIVEN** a PR that added a resource to `envs/cluster/*.tf` without the operator having run `tofu apply` first
- **WHEN** `plan-infra.yml` runs
- **THEN** `tofu plan -detailed-exitcode` SHALL return exit code 2 for cluster
- **AND** the `plan (cluster)` check SHALL fail
- **AND** the PR SHALL be blocked from merging by the `main` ruleset's required-status-checks rule

#### Scenario: No admin bypass

- **GIVEN** a repository admin opening a PR whose `plan (cluster)` check is failing
- **WHEN** they attempt to merge
- **THEN** the merge SHALL be blocked
- **AND** the only recovery SHALL be to fix the drift or to temporarily flip the ruleset's `enforcement` field to `disabled` via `gh api PUT`

### Requirement: Helm-rendered-object drift blind spot

Operators SHALL NOT bypass Helm for drift-guard-protected workloads. The drift guard (`plan-infra.yml`) detects drift only in Terraform-managed fields: Helm chart versions, module arguments, K8s manifests declared directly by Terraform. Raw `kubectl edit` on an object rendered *inside* a Helm release (e.g., hand-editing the Traefik Deployment rendered by the Traefik Helm chart) produces drift the gate cannot see, because Terraform tracks the Helm release version, not its rendered objects.

This is a documented operational norm, not a physical constraint — Terraform has no way to enforce it. The project's policy is: anything that should be drift-protected SHALL be expressed through Terraform (either as a Helm release module argument or as a direct Terraform-managed Kubernetes resource); anything hand-edited via `kubectl` is explicitly unguarded and SHALL be returned to its desired state promptly.

#### Scenario: Helm rendered Traefik Deployment is not drift-guarded

- **GIVEN** an operator runs `kubectl edit deployment traefik -n traefik` and changes the replica count
- **WHEN** `plan-infra.yml` runs on any subsequent PR
- **THEN** the plan SHALL show zero changes (Terraform tracks the Helm release version, not its rendered Deployment)
- **AND** the edit SHALL be recorded as an operational mistake, not an infra-as-code change

### Requirement: auth_allow sourced from GitHub repo variables

The `auth_allow` tfvar for prod and staging SHALL NOT be committed in `infrastructure/envs/prod/terraform.tfvars` or `infrastructure/envs/staging/terraform.tfvars`. It SHALL be sourced from GitHub repository variables (not secrets — the allowlist is not confidential):

- `AUTH_ALLOW_PROD` → fed to `envs/prod/` via `TF_VAR_auth_allow` in `deploy-prod.yml`.
- `AUTH_ALLOW_STAGING` → fed to `envs/staging/` via `TF_VAR_auth_allow` in `deploy-staging.yml`.

The TF variable SHALL remain required (no default). An unset GitHub variable SHALL expand to empty string at apply time, which the runtime's `createConfig` maps to the empty provider-registry posture (every protected route SHALL respond 401/302 — fail-closed at runtime, not at apply).

`infrastructure/envs/local/terraform.tfvars` SHALL continue to commit `auth_allow` inline (developer-operated).

#### Scenario: GH variable feeds TF_VAR

- **GIVEN** `AUTH_ALLOW_PROD = "github:user:alice,github:org:acme"` is set as a GitHub repo variable
- **WHEN** `deploy-prod.yml` runs
- **THEN** the `apply` job SHALL export `TF_VAR_auth_allow` to that value before running `tofu apply`
- **AND** the rendered app Deployment SHALL have `AUTH_ALLOW = "github:user:alice,github:org:acme"` in its env

#### Scenario: Unset GH variable yields empty-registry runtime posture

- **GIVEN** `AUTH_ALLOW_PROD` is unset
- **WHEN** `deploy-prod.yml` runs
- **THEN** `TF_VAR_auth_allow` SHALL expand to empty string
- **AND** `tofu apply` SHALL succeed (no validation error — the variable is declared but optional at the runtime layer)
- **AND** the app SHALL start successfully but respond 401/302 on every protected route

### Requirement: Release branch powers automated prod deploys

Production deploys SHALL run via `.github/workflows/deploy-prod.yml` triggered on push to the long-lived `release` branch. The workflow SHALL be split into two jobs:

1. `plan` — builds + pushes `ghcr.io/stefanhoelzl/workflow-engine:release`, captures the image digest from the `docker/build-push-action` output, and renders `tofu plan` into the GitHub run summary. Outputs the digest.
2. `apply` — declares `environment: production` to trigger the required-reviewer gate; on approval, runs `tofu apply -var image_digest=<digest>` against `envs/prod/`; fetches kubeconfig via `upctl`; blocks on `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m`.

Operator rollback flow: `git revert <bad-sha>` on the `release` branch, then `git push origin release` — the workflow rebuilds the previous code and redeploys.

Required repo secrets for prod: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_SECRET_PROD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

#### Scenario: Push to release triggers plan + approval + apply

- **WHEN** a commit is pushed to the `release` branch
- **THEN** `deploy-prod.yml` SHALL start
- **AND** the `plan` job SHALL complete automatically, producing a digest output
- **AND** the `apply` job SHALL enter a "waiting for approval" state
- **AND** the configured reviewers SHALL be notified
- **AND** on approval, `tofu apply -var image_digest=<digest>` SHALL run
- **AND** the apply SHALL block on `kubectl wait` for the prod Certificate to become Ready

#### Scenario: Release branch is protected

- **WHEN** any user attempts `git push --force origin release`
- **THEN** the push SHALL be rejected by branch protection
- **AND** deletion of the `release` branch SHALL also be rejected

### Requirement: Staging auto-deploys on push to main

Staging deploys SHALL run via `.github/workflows/deploy-staging.yml` triggered on push to `main`. The workflow SHALL build + push `ghcr.io/stefanhoelzl/workflow-engine:main`, capture the digest from `docker/build-push-action`, and run `tofu apply -var image_digest=<digest>` against `envs/staging/`.

Required repo secrets for staging: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `TF_VAR_OAUTH2_CLIENT_ID`, `TF_VAR_OAUTH2_CLIENT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

The first staging deploy SHALL be bootstrapped via `workflow_dispatch`: an operator triggers the workflow manually to capture a digest, then runs `tofu -chdir=infrastructure/envs/staging apply -var image_digest=sha256:...` locally to establish initial state.

#### Scenario: Push to main triggers staging deploy

- **WHEN** a commit is pushed to `main`
- **THEN** `deploy-staging.yml` SHALL run
- **AND** the build SHALL produce a digest
- **AND** `tofu apply` SHALL run against `envs/staging/` with that digest
- **AND** no approval gate SHALL block the apply (staging is unattended)

### Requirement: cert-manager Helm chart CRD upgrade caveat

cert-manager SHALL be installed via Helm release by the `modules/cert-manager/` module. The Helm release SHALL be configured with `installCRDs=true`, which installs CRDs only on FIRST-release install (not on subsequent `helm upgrade` calls). When bumping the cert-manager chart version in the module, operators SHALL manually apply the new CRDs before running `tofu apply`:

```
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/<new-version>/cert-manager.crds.yaml
tofu -chdir=infrastructure/envs/cluster apply
```

Failure to apply CRDs before apply SHALL produce a Helm upgrade error if the new chart references CRD fields not present in the live API surface.

#### Scenario: CRD-first upgrade flow

- **GIVEN** an operator bumping cert-manager from vA to vB in `infrastructure/modules/cert-manager/cert-manager.tf`
- **WHEN** they run `kubectl apply -f .../releases/download/vB/cert-manager.crds.yaml` against the cluster
- **AND** then run `tofu -chdir=infrastructure/envs/cluster apply`
- **THEN** the Helm upgrade SHALL succeed

### Requirement: Cert readiness verification

After `tofu apply` on an app project completes, operators SHALL verify ACME HTTP-01 issuance has produced a served certificate. `tofu apply` returns once K8s resources are created; ACME issuance happens asynchronously over ~30-90 s. The verification command SHALL be:

- Prod: `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m`
- Staging: `kubectl wait --for=condition=Ready certificate/staging-workflow-engine -n staging --timeout=5m`

Failure of that wait SHALL indicate a misconfiguration — DNS resolution, port 80 reachability, CAA records, or ClusterIssuer state. Operators SHALL inspect via `kubectl describe certificate <name> -n <ns>` and `kubectl describe challenge -n <ns>` to diagnose.

The `deploy-prod.yml` `apply` job SHALL embed the prod `kubectl wait` command as its final step so CI failure signals cert-readiness failure, not just apply failure.

#### Scenario: Cert ready after prod apply

- **GIVEN** `deploy-prod.yml`'s `apply` job has just run `tofu apply`
- **WHEN** the `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m` step runs
- **THEN** it SHALL complete within 5 minutes when DNS + port 80 + CAA are correctly configured

## MODIFIED Requirements

### Requirement: Module wiring

The local root (`envs/local/local.tf`) SHALL instantiate the following modules: `kubernetes/kind`, `image/build`, `object-storage/s2`, `baseline`, `cert-manager`, `traefik`, and `app-instance`. The kubernetes and helm providers SHALL be configured from the cluster module's credential outputs. The traefik module SHALL receive service configuration. The app-instance module SHALL receive baseline, traefik readiness, and per-instance config.

Local stack SHALL NOT include an oauth2-proxy workload — that sidecar was removed by `replace-oauth2-proxy` and replaced by in-app OAuth (see the `auth` capability). Authentication is end-to-end in-app; no sidecar proxies forward-auth.

#### Scenario: Single apply creates everything

- **WHEN** `tofu apply` is run on a clean state
- **THEN** a kind cluster SHALL be created
- **AND** the app image SHALL be built and loaded
- **AND** workload namespaces SHALL be created with PSA labels
- **AND** S2 SHALL be deployed in the `persistence` namespace and the app in its namespace
- **AND** the Traefik Helm release SHALL be deployed in `ns/traefik`
- **AND** cert-manager SHALL be deployed in `ns/cert-manager` with a selfsigned CA ClusterIssuer
- **AND** per-instance routes Helm releases SHALL be deployed

### Requirement: Non-secret variables in terraform.tfvars

The local root SHALL load non-secret configuration from `terraform.tfvars` (committed): `domain`, `https_port`, `auth_allow`, `s2_bucket`. The `auth_allow` variable SHALL be a string matching the grammar defined in the `auth` capability (comma-separated `provider:rest` entries) and SHALL be passed to the app module as the `AUTH_ALLOW` runtime environment variable.

The legacy `oauth2_github_users` variable SHALL NOT exist; it was removed by `replace-oauth2-proxy` along with the oauth2-proxy sidecar.

#### Scenario: Default local values

- **WHEN** `terraform.tfvars` is read
- **THEN** `domain` SHALL be `"localhost"`
- **AND** `https_port` SHALL be `8443`
- **AND** `auth_allow` SHALL be a comma-separated `AUTH_ALLOW` string (e.g., `"github:user:stefanhoelzl,local:dev"`)

### Requirement: Secret variables in local.secrets.auto.tfvars

The local root SHALL load secrets from `local.secrets.auto.tfvars` (gitignored): `github_oauth_client_id`, `github_oauth_client_secret`. These SHALL be declared as `sensitive = true` variables in `envs/local/local.tf` and fed to the app module's in-app OAuth wiring.

The legacy variable names `oauth2_client_id` / `oauth2_client_secret` SHALL NOT exist — they belonged to the deleted oauth2-proxy sidecar.

#### Scenario: Secrets gitignored

- **WHEN** the `.gitignore` is checked
- **THEN** `*.secrets.auto.tfvars` SHALL be listed as ignored

#### Scenario: Missing secrets file fails

- **WHEN** `tofu apply` is run without `local.secrets.auto.tfvars`
- **THEN** it SHALL fail requesting values for `github_oauth_client_id` and `github_oauth_client_secret`

### Requirement: App workload network allow-rules

The app pod SHALL be protected by a `NetworkPolicy` that denies all inbound traffic except from Traefik pods on TCP 8080, and denies all outbound traffic except to:

- CoreDNS on TCP/UDP 53 (cluster DNS resolution).
- Persistence object store (either the S2 pod in local dev or UpCloud S3 API endpoints in production) on TCP 443.
- GitHub API (`api.github.com`) on TCP 443 for in-app OAuth + `/user` + `/user/orgs` reads — since the fix is DNS-resolved, the NetworkPolicy SHALL express the allow rule as egress to `0.0.0.0/0` TCP 443 with an explicit FQDN policy if supported, or as a CIDR-free egress rule if not.
- Outbound workflow `fetch()` calls per `hardenedFetch` pipeline (allowed egress to public IPs only, enforced host-side; the NetworkPolicy does not further restrict these because IANA-range filtering is a runtime concern).

The NetworkPolicy SHALL NOT allow inbound from any oauth2-proxy pod — that sidecar no longer exists. The NetworkPolicy remains load-bearing as defence-in-depth per `SECURITY.md §5 R-I1`.

#### Scenario: Non-Traefik inbound rejected

- **WHEN** any pod other than Traefik attempts to connect to the app on `:8080`
- **THEN** the connection SHALL be refused by the NetworkPolicy

#### Scenario: Traefik inbound permitted

- **GIVEN** a request reaching the app from a Traefik pod via Traefik's IngressRoute
- **WHEN** the app receives the request
- **THEN** the NetworkPolicy SHALL permit the connection

### Requirement: Traefik workload network allow-rules

The Traefik pod SHALL be protected by a `NetworkPolicy` that allows inbound LoadBalancer traffic on :80 and :443 and allows outbound to:

- The app pod on TCP 8080 (the sole upstream).
- ACME HTTP-01 solver pods on TCP 8089 (during certificate issuance) — expressed as egress to pods matching the label `acme.cert-manager.io/http01-solver=true` across all namespaces.
- CoreDNS on TCP/UDP 53.

Traefik SHALL NOT perform forward-auth to any oauth2-proxy sidecar (that sidecar was removed by `replace-oauth2-proxy`); authentication is entirely in-app on the app pod. The NetworkPolicy SHALL therefore NOT allow outbound to any `oauth2-proxy` pod-selector.

#### Scenario: Traefik forwards to app, not to a proxy

- **GIVEN** a request reaching Traefik on :443
- **WHEN** Traefik's IngressRoute resolves to the app service
- **THEN** Traefik SHALL open a connection directly to the app pod on :8080
- **AND** no forward-auth hop to any intermediate proxy SHALL occur

## REMOVED Requirements

### Requirement: Container image from ghcr.io

**Reason**: Replaced by `Prod image identity via digest` (existing requirement at L993) and `Staging image identity via digest` (existing at L1013) introduced by `automate-prod-deployment`. The `image_tag` variable + `:latest` default + calver-tag convention were all retired; deploys are digest-pinned (`@sha256:...` form) only.

**Migration**: See `Prod image identity via digest` and `Staging image identity via digest` for the current contract (GHA-injected `image_digest` var; `@sha256:...` form in the container spec).

### Requirement: Traefik with LoadBalancer and TLS-ALPN-01

**Reason**: Replaced by the `modules/cert-manager/` Helm-release module producing a `letsencrypt-prod` ClusterIssuer and per-app-project `Certificate` resources using HTTP-01 challenge solver pods. Traefik no longer carries its built-in Let's Encrypt resolver, its ACME challenge, or its `traefik-certs` PVC. Documented by the `cluster project composition root` requirement (L915) + `app-instance module creates Certificate and solver NetworkPolicy` (L1059).

**Migration**: See `cluster project composition root` and `app-instance module creates Certificate and solver NetworkPolicy` for the current cert-manager-based model.

### Requirement: Tofu-managed Traefik cert PVC

**Reason**: The `traefik-certs` PVC existed only to back Traefik's built-in ACME resolver, which has been replaced by cert-manager. Traefik's Helm release no longer mounts a cert-storage PVC — certificates are stored in Kubernetes `Certificate` + `Secret` resources managed by cert-manager per app-project namespace.

**Migration**: None. cert-manager owns certificate storage via standard Kubernetes Secrets in each app namespace.

### Requirement: Clean destroy of Traefik cert storage

**Reason**: Same as above. No `traefik-certs` PVC exists to destroy.

**Migration**: `tofu destroy` on an app project deletes that project's `Certificate` resource; cert-manager removes the backing `Secret` automatically.

### Requirement: CLAUDE.md production documentation

**Reason**: The production runbook was relocated to `docs/infrastructure.md` (per a recent user-driven CLAUDE.md restructure that left only a `Prod/staging runbook: docs/infrastructure.md` pointer in the `## Infrastructure` section). CLAUDE.md no longer carries the full env-var matrix, apply order, or CI-deploy documentation inline — those live in `docs/infrastructure.md`.

**Migration**: Documentation ownership moved to `docs/infrastructure.md`. Deploy-process specs are captured in the ADDED requirements above (`Release branch powers automated prod deploys`, `Staging auto-deploys on push to main`, `Drift guard via plan-infra.yml`).

### Requirement: Persistence project path

**Reason**: Transition-era requirement describing the path move from `infrastructure/envs/upcloud/persistence/` → `infrastructure/envs/persistence/` during `separate-app-projects`. The transition is long complete; the path is now documented by the current `Persistence project` requirement (L581) and `State key layout` (L1096).

**Migration**: See `Persistence project` (current path: `infrastructure/envs/persistence/`) and `State key layout` (current state key: `persistence`).
