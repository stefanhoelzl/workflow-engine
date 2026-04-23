# Infrastructure

Prod/staging deployment runbook. Local-dev instructions live in `CLAUDE.md` under `## Infrastructure (OpenTofu + kind)`.

## Production (OpenTofu + UpCloud)

Prerequisites: OpenTofu >= 1.11, UpCloud account, Dynu DNS domain, two GitHub OAuth Apps (prod + staging).

Four OpenTofu projects under `infrastructure/envs/`:

| Dir           | State key     | Owns                                                                 |
| ------------- | ------------- | -------------------------------------------------------------------- |
| `persistence/` | `persistence` | Prod app S3 bucket + scoped user (in a pre-created OS instance)      |
| `cluster/`    | `cluster`     | K8s cluster, Traefik + LB, cert-manager + `letsencrypt-prod` issuer  |
| `prod/`       | `prod`        | Prod namespace, Certificate, app, Dynu CNAME; reads persistence S3   |
| `staging/`    | `staging`     | Staging namespace, own bucket, Certificate, app, Dynu CNAME          |

State credentials via `AWS_*` (S3 backend requirement); secrets via `TF_VAR_*`. Each project declares only the vars it uses.

### Per-project credentials

Shared across all projects:
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — S3 state backend (scoped to `tofu-state` bucket only)
- `TF_VAR_state_passphrase` — client-side state encryption (pbkdf2 + AES-GCM)

| Project       | `TF_VAR_upcloud_token` scope              | Other required vars                                                                |
| ------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `persistence/` | Object Storage                           | — (non-secret tfvars: `service_uuid`, `service_endpoint`, `bucket_name`)           |
| `cluster/`    | K8s + networking (for LB lookup)         | `TF_VAR_acme_email` (or set via tfvar); no user-facing secrets                     |
| `prod/`       | K8s read (ephemeral block re-fetch)      | `TF_VAR_dynu_api_key`, `TF_VAR_github_oauth_client_id`, `TF_VAR_github_oauth_client_secret`, `TF_VAR_auth_allow` (from GH variable `AUTH_ALLOW_PROD`), plus `image_digest` supplied at apply time |
| `staging/`    | K8s read + Object Storage (own bucket)   | same as prod but `TF_VAR_auth_allow` sourced from GH variable `AUTH_ALLOW_STAGING`, plus `image_digest` supplied at apply time |

Non-secret tfvars committed in each project's `terraform.tfvars`:
- `cluster/`: `acme_email`
- `prod/`: `domain`
- `staging/`: `domain`, `service_uuid`, `service_endpoint`, `bucket_name`

The `auth_allow` input for prod and staging is sourced from the `AUTH_ALLOW_PROD` / `AUTH_ALLOW_STAGING` GitHub repo variables (not secrets — the allowlist is not confidential) and passed to `tofu` via `TF_VAR_auth_allow` in the deploy workflows. `envs/local/terraform.tfvars` still carries `auth_allow` inline.

K8s cluster config (`zone`, `kubernetes_version`, `node_plan`, `node_cidr`) is hardcoded as locals in `infrastructure/modules/kubernetes/upcloud/upcloud.tf`.

### Apply order (one-time)

1. `tofu -chdir=infrastructure/envs/persistence apply` — prod bucket + scoped user
2. `tofu -chdir=infrastructure/envs/cluster apply` — cluster, Traefik, cert-manager, ClusterIssuer (~12-17 min)
3. `tofu -chdir=infrastructure/envs/prod apply` — prod namespace, Certificate, app, DNS
4. Bootstrap staging: trigger the `Deploy staging` GHA workflow via `workflow_dispatch` to capture a digest, then locally run `tofu -chdir=infrastructure/envs/staging apply -var image_digest=sha256:...`

### Subsequent deploys

- **Prod** (CI-driven with approval gate): every push to the long-lived `release` branch triggers `.github/workflows/deploy-prod.yml`. Two-job split: (1) `plan` builds + pushes `ghcr.io/<repo>:release`, captures the digest, and renders `tofu plan` into the run's Summary; (2) `apply` declares `environment: production`, pauses for required-reviewer approval, then runs `tofu apply -var image_digest=<digest>` on `envs/prod/`, fetches kubeconfig via `upctl`, and blocks on `kubectl wait` for the prod Certificate. Cherry-pick workflow: `git cherry-pick <sha>` onto a local `release` checkout, `git push origin release`, approve the pending run in the Actions tab. Required repo secrets: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_SECRET_PROD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Rollback: `git revert <bad-sha>` on `release`, then `git push origin release` → workflow rebuilds prior code and redeploys. The `release` branch is protected against force-push and deletion.
- **Staging** (CI-driven): every push to `main` triggers `.github/workflows/deploy-staging.yml`, which builds + pushes `ghcr.io/<repo>:main`, captures the digest from `docker/build-push-action`, and runs `tofu apply` on `envs/staging/` with the digest. Required repo secrets: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `TF_VAR_OAUTH2_CLIENT_ID`, `TF_VAR_OAUTH2_CLIENT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

### Operator flow for manual infrastructure projects

`envs/cluster/` and `envs/persistence/` stay operator-applied by design (blast radius too large for unattended CI apply). To keep `main` honest against live state, `.github/workflows/plan-infra.yml` runs `tofu plan -detailed-exitcode -lock=false -no-color` on every PR to `main` against both projects; a `main` branch ruleset requires both status checks (`plan (cluster)` and `plan (persistence)`) to pass. The merge gate is the drift guard — no cron, no reconciliation loop.

**Apply-first-then-PR flow.** When you change `cluster/` or `persistence/`:

1. `git pull --rebase origin main` — **required** before `tofu apply`. Applying from a stale branch can silently revert another operator's in-flight apply (UpCloud state lockfile serialises simultaneous applies, not stale-branch ones).
2. Edit the `.tf` file locally.
3. `tofu -chdir=infrastructure/envs/<project> apply` — state is updated, reality reflects your change.
4. Commit the same `.tf` edits, push the branch, open a PR.
5. `plan (cluster)` and `plan (persistence)` report empty plans → green → merge.

**Known gap.** `tofu plan` detects drift only in Terraform-managed fields: Helm chart versions, module arguments, K8s manifests declared directly by Terraform. Raw `kubectl edit` on objects *inside* a Helm release (e.g., hand-editing the Traefik Deployment rendered by the Helm chart) produces drift the gate cannot see, because Terraform tracks the Helm release version, not its rendered objects. **Do not bypass Helm** for anything you want the gate to protect.

**Escape hatch when the gate is broken.** The `main` ruleset has `bypass_actors: []` — no per-PR admin bypass. If the gate wedges:

- **Credential failures** (`TF_VAR_UPCLOUD_TOKEN` expired, `AWS_*` rotated): `gh secret set <NAME>` directly. No merge needed; the next PR push re-runs the workflow with the new secret.
- **Workflow file regression** (bug in `plan-infra.yml` itself): `gh api --method PUT repos/stefanhoelzl/workflow-engine/rulesets/<main-ruleset-id>` with `"enforcement": "disabled"`, merge the fix, then `PUT` again with `"enforcement": "active"`. While disabled the ruleset bypasses *all* main's rules (deletion, force-push, required reviews, required checks) — flip it back promptly. Get the id with `gh api repos/stefanhoelzl/workflow-engine/rulesets`.

**Onboarding a new manual project.** If a future `envs/<new-project>/` is added as another operator-driven project: append it to `.github/workflows/plan-infra.yml`'s `matrix.project` list (one line) and add `plan (<new-project>)` to the `main` ruleset's `required_status_checks` via `gh api`. No other changes needed.

### Cert readiness check

`tofu apply` on an app project returns once all K8s resources are created. ACME HTTP-01 issuance happens asynchronously over ~30-90 s. To block until the cert is served:

```
kubectl wait --for=condition=Ready certificate/prod-workflow-engine    -n prod    --timeout=5m
kubectl wait --for=condition=Ready certificate/staging-workflow-engine -n staging --timeout=5m
```

Failure of that wait means DNS, port 80 reachability, CAA records, or another prerequisite is misconfigured — inspect via `kubectl describe certificate <name> -n <ns>`.

### cert-manager chart upgrades

`installCRDs=true` installs CRDs only on first release install, not on subsequent Helm upgrades. When bumping the cert-manager chart version in `infrastructure/modules/cert-manager/cert-manager.tf`, first apply the new CRDs manually (from the cluster project's kubeconfig):

```
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/<new-version>/cert-manager.crds.yaml
```

then run `tofu -chdir=infrastructure/envs/cluster apply` to upgrade the Helm release.

### URLs

- Prod: `https://workflow-engine.webredirect.org`
- Staging: `https://staging.workflow-engine.webredirect.org`

Both served via Let's Encrypt TLS managed by cert-manager; Certificate resources live in each app project's namespace and are rendered by the routes-chart.
