# Infrastructure

Prod/staging deployment runbook. Local-dev instructions live in `CLAUDE.md` under `## Infrastructure (OpenTofu + kind)`.

## Authentication architecture

Authentication is entirely in-app. The `oauth2-proxy` sidecar and Traefik forward-auth chain were removed by the `replace-oauth2-proxy` change. Traefik is now a pure TLS + routing gateway; it performs no authentication, authorization, or forward-auth gating. The workflow-engine app owns every URL prefix and mounts `sessionMiddleware` (UI: `/dashboard/*`, `/trigger/*`) and `apiAuthMiddleware` (API: `/api/*`) in-process. See `openspec/specs/auth/spec.md` for the full auth contract and `SECURITY.md §4` for the threat model.

## Production (OpenTofu + UpCloud)

Prerequisites: OpenTofu >= 1.11, UpCloud account, Dynu DNS domain, two GitHub OAuth Apps (prod + staging).

Four OpenTofu projects under `infrastructure/envs/`:

| Dir           | State key     | Owns                                                                 |
| ------------- | ------------- | -------------------------------------------------------------------- |
| `persistence/` | `persistence` | Prod app S3 bucket + scoped user (in a pre-created OS instance)      |
| `cluster/`    | `cluster`     | K8s cluster, Traefik + LB, cert-manager + `letsencrypt-prod` issuer  |
| `prod/`       | `prod`        | Prod namespace, Certificate, app, Dynu CNAME; reads persistence S3   |
| `staging/`    | `staging`     | Staging namespace, own bucket, Certificate, app, Dynu CNAME          |

The S3 bucket is accessed by the runtime through the `StorageBackend` interface (`init`, `read`/`write`, `readBytes`/`writeBytes`, `list`, `remove`, `removePrefix`, `move`). Tenant bundles live under `workflows/<tenant>.tar.gz`; invocation events live under `events/pending/` and `events/archive/`. Both FS-backed (local dev) and S3-backed implementations exist; atomicity is provided per-write (FS: tmp+rename; S3: PutObject). The authoritative contract — including the FS-vs-S3 selection logic via `PERSISTENCE_PATH` / `PERSISTENCE_S3_*` env vars — is in `openspec/specs/storage-backend/spec.md`.

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
- **Staging** (CI-driven): every push to `main` triggers `.github/workflows/deploy-staging.yml`, which builds + pushes `ghcr.io/<repo>:main`, captures the digest from `docker/build-push-action`, and runs `tofu apply` on `envs/staging/` with the digest. Required repo secrets: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `GH_APP_CLIENT_ID_STAGING`, `GH_APP_CLIENT_SECRET_STAGING`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. The pre-merge `plan (staging)` check (see "Pre-merge plan gate" below) catches type/state regressions before they can reach this workflow.

### Pre-merge plan gate

`.github/workflows/plan-infra.yml` plans every `envs/` project on every PR to `main`. Four required status checks block merge:

| Project       | Check name           | `changes-allowed` | Semantics                                                             |
| ------------- | -------------------- | ----------------- | --------------------------------------------------------------------- |
| `cluster/`    | `plan (cluster)`     | `false`           | Operator-applied. Must plan **clean** — any pending change fails.      |
| `persistence/` | `plan (persistence)` | `false`           | Operator-applied. Must plan **clean** — any pending change fails.      |
| `staging/`    | `plan (staging)`     | `true`            | CI-applied on merge. Plan must **succeed**; changes are expected.      |
| `prod/`       | `plan (prod)`        | `true`            | CI-applied on `release` push. Plan must **succeed**; changes expected. |

All four use `tofu plan -detailed-exitcode`:

- `changes-allowed: false` — exit 0 passes, exit 1 or 2 fails. A dirty plan means the base layer has not been applied yet; merging would publish a Terraform spec that disagrees with remote state.
- `changes-allowed: true` — exit 0 and 2 pass, exit 1 fails. Staging/prod planning against the consumed `terraform_remote_state.cluster` / `.persistence` would have caught PR #144: a base-layer output-shape change without a preceding base-layer apply produces exit 1 at plan time (type-constraint rejection of the stale remote-state value).

Staging and prod plans pass `-var image_digest=sha256:0000...` (dummy digest). `tofu plan` does not validate against the container registry; the digest is only interpolated into the Deployment spec string, so the dummy is sufficient for shape/state checking. The real digest is produced by `docker-build` at apply time.

**Apply-first-then-PR flow** (required when a PR changes `cluster/` or `persistence/`):

1. `git pull --rebase origin main` — **required** before `tofu apply`. Applying from a stale branch can silently revert another operator's in-flight apply (UpCloud state lockfile serialises simultaneous applies, not stale-branch ones).
2. Edit the `.tf` file locally.
3. `tofu -chdir=infrastructure/envs/<project> apply` — state is updated; remote state now carries the new output shape.
4. Commit the same `.tf` edits, push the branch, open (or re-push) a PR.
5. `plan (cluster)` / `plan (persistence)` now report **empty plans → green**. `plan (staging)` / `plan (prod)` re-read the new remote-state outputs and type-check against them → green → merge.

Required env vars for local apply: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (scoped to `tofu-state` bucket), `TF_VAR_state_passphrase`, `TF_VAR_upcloud_token`. `cluster/` additionally needs `TF_VAR_acme_email` (or the value from `terraform.tfvars`).

**Known gap.** `tofu plan` detects drift only in Terraform-managed fields: Helm chart versions, module arguments, K8s manifests declared directly by Terraform. Raw `kubectl edit` on objects *inside* a Helm release (e.g., hand-editing the Traefik Deployment rendered by the Helm chart) produces drift the gate cannot see, because Terraform tracks the Helm release version, not its rendered objects. **Do not bypass Helm** for anything you want the gate to protect.

**Escape hatch when the gate is broken.** The `main` ruleset has `bypass_actors: []` — no per-PR admin bypass. If the gate wedges:

- **Credential failures** (`TF_VAR_UPCLOUD_TOKEN` expired, `AWS_*` rotated): `gh secret set <NAME>` directly. No merge needed; the next PR push re-runs the workflow with the new secret.
- **Workflow file regression** (bug in `plan-infra.yml` itself): `gh api --method PUT repos/stefanhoelzl/workflow-engine/rulesets/<main-ruleset-id>` with `"enforcement": "disabled"`, merge the fix, then `PUT` again with `"enforcement": "active"`. While disabled the ruleset bypasses *all* main's rules (deletion, force-push, required reviews, required checks) — flip it back promptly. Get the id with `gh api repos/stefanhoelzl/workflow-engine/rulesets`.

**Onboarding a new project.** Append an `include:` entry to `.github/workflows/plan-infra.yml`'s matrix with the right `changes-allowed` flag (`false` for operator-applied, `true` for CI-applied) and add `plan (<new-project>)` to the `main` ruleset's `required_status_checks` via `gh api`. If the new project declares an `image_digest` variable, extend the `plan_args` conditional that injects the dummy digest.

### Storage backend selection

The runtime chooses its `StorageBackend` from two mutually-exclusive env vars:

- `PERSISTENCE_PATH` — filesystem backend rooted at the given directory. Used by local dev and by tests. Also hosts tenant workflow bundles at `workflows/<tenant>.tar.gz` under the same root.
- `PERSISTENCE_S3_BUCKET` — S3 backend pointing at the named bucket. Used in staging and production.

Setting both is a configuration error — `createConfig` SHALL reject the runtime start with a clear message. Setting neither SHALL also fail; every deployment declares exactly one.

When `PERSISTENCE_S3_BUCKET` is set, the runtime reads S3 credentials from the standard AWS SDK chain: `PERSISTENCE_S3_ENDPOINT`, `PERSISTENCE_S3_REGION`, `PERSISTENCE_S3_ACCESS_KEY_ID`, and `PERSISTENCE_S3_SECRET_ACCESS_KEY`. These arrive in the pod via `envFrom.secretRef` pointing at the `app-persistence` K8s Secret, which is populated by the `envs/prod/` (and `envs/staging/`) project from the `TF_VAR_upcloud_token`-scoped Object Storage user created by `envs/persistence/`. The app pod therefore never sees long-lived root credentials — only the scoped user's access key pair, restricted to the single bucket.

Storage key layout: event records live under `events/pending/` and `events/archive/` prefixes; workflow bundles live under `workflows/<tenant>.tar.gz`. Both backends implement the same `StorageBackend` interface (byte-level read/write + JSON record helpers), so switching from filesystem to S3 requires no application-code change beyond the env-var swap.

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

### Pod-security baseline

`modules/baseline/` owns three cluster-wide security controls consumed by every workload module:

1. **Namespace creation with PodSecurity Admission (PSA) labels.** Each namespace in `var.namespaces` is created with `pod-security.kubernetes.io/<var.psa_mode>=restricted`. The mode is `enforce` by default; during a cluster bootstrap or major workload change it should be flipped to `warn` first.
2. **Default-deny `NetworkPolicy`** in every namespace. App-level modules (`app-instance`, `traefik`, `object-storage/s2`) layer their own allow-rules on top via `modules/netpol/`.
3. **Shared `security_context` / selector outputs** — `pod_security_context`, `container_security_context`, `rfc1918_except`, `node_cidr`, `coredns_selector`. The `coredns_selector` output uses the shorthand form `{ namespace = "kube-system", k8s_app_in = ["coredns", "kube-dns"] }`; `modules/netpol/` expands it into the verbose K8s `namespace_selector` + pod `match_expressions` structure internally.

**Apply order.** `module.baseline` must apply before any workload module in the same project (namespace must exist before any workload or NetworkPolicy in it). In `envs/cluster/` the baseline also creates the `traefik` and `cert-manager` namespaces; in `envs/prod/` and `envs/staging/` it creates the app namespace.

**Two-phase PSA rollout.** The `psa_mode` variable switches the enforcement label:

- **Phase 1 — `psa_mode = "warn"`.** Applies `pod-security.kubernetes.io/warn=restricted`. Non-compliant pods emit a warning at admission but are still created. Use this when introducing new workloads (or upgrading a chart that may have changed its pod spec). Run `tofu apply` and inspect `kubectl get events` / `tofu apply` output for PodSecurity warnings; resolve every one before proceeding.
- **Phase 2 — `psa_mode = "enforce"` (default).** Applies `pod-security.kubernetes.io/enforce=restricted`. Non-compliant pods are rejected at admission. Only flip to enforce after phase 1 has produced zero warnings against the target workload set.

Both phases are one `tofu apply` each; the label change is a namespace-metadata update (no pod restart). For steady-state operation leave `psa_mode = "enforce"`.

**Traefik ServiceAccount token.** Per SECURITY.md §5 R-I11, Traefik pods keep their SA token mounted (`serviceAccount.automountServiceAccountToken = true` in the Helm values) because the controller watches `Ingress` / `IngressRoute` / `Middleware` CRDs via the K8s API. All other workloads (`app`, `s2`) set `automount_service_account_token = false` on the pod spec.

### URLs

- Prod: `https://workflow-engine.webredirect.org`
- Staging: `https://staging.workflow-engine.webredirect.org`

### One-shot deploy steps

**`scripts/prune-legacy-storage.ts` — (owner, repo) split cleanup.** Required
before the first deploy of the `add-per-repo-workflows` change (see
`openspec/changes/add-per-repo-workflows/proposal.md` §9). Wipes
`workflows/`, `archive/`, and `pending/` prefixes on the configured
persistence backend; the new schema keys bundles by `(owner, repo)` and
gives events mandatory `owner` / `repo` columns, so legacy single-owner
records would fail to decode on startup.

Run against each environment's backend before rolling out the new image:

```
# staging: point at staging's S3
STORAGE_ENDPOINT=<staging-endpoint> STORAGE_BUCKET=<staging-bucket> \
STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
pnpm tsx scripts/prune-legacy-storage.ts

# prod: point at prod's S3
STORAGE_ENDPOINT=<prod-endpoint> STORAGE_BUCKET=<prod-bucket> \
STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
pnpm tsx scripts/prune-legacy-storage.ts
```

Idempotent: re-running on an already-pruned backend reports `0 key(s)` for
each prefix.

Both served via Let's Encrypt TLS managed by cert-manager; Certificate resources live in each app project's namespace and are rendered by the routes-chart.

### Staging demo upload token rotation

`.github/workflows/deploy-staging.yml` uploads `workflows/src/demo.ts` to the staging runtime after each `tofu apply`. The upload authenticates as `github:user:stefanhoelzl` using a fine-grained Personal Access Token stored in the repository secret `GH_UPLOAD_TOKEN`.

- **Token owner:** `stefanhoelzl` (must match an entry in the `AUTH_ALLOW_STAGING` GitHub Actions variable — currently `github:user:stefanhoelzl`).
- **Required scopes:** none. `GET /user` (the only endpoint the workflow-engine's github auth provider calls) works with any authenticated token.
- **Expiry:** fine-grained PATs expire at most 1 year after issue. Note the expiry date when creating the token.
- **Symptom of expiry:** `deploy-staging` fails at the `Upload workflows bundle` step with a `401 Unauthorized` from `/api/workflows/stefanhoelzl/workflow-engine`. The job is marked red; the freshly-deployed runtime is otherwise healthy.
- **Rotation:**
  1. Create a new fine-grained PAT on `github.com/settings/tokens?type=beta` under the `stefanhoelzl` account. Repository access: `stefanhoelzl/workflow-engine` only. No scopes beyond the default.
  2. Update the repository secret: `Settings → Secrets and variables → Actions → GH_UPLOAD_TOKEN`.
  3. Re-run the failed `deploy-staging` run (or push a no-op commit to `main`) to verify the new token works.
  4. Revoke the old PAT.

### Single-replica invariant (do not raise `replicas` above 1)

The app Deployment for both prod and staging MUST be kept at `replicas = 1`. The auth capability seals the session cookie with a password generated in-memory at pod start (`packages/runtime/src/auth/key.ts`); the password is not shared across pods. A second replica would sign cookies with a different password and requests that land on the pod that did not seal the cookie would fail to decrypt it, producing deterministic re-login loops.

Raising the replica count requires migrating the sealing password to a shared mechanism (e.g. a K8s Secret generated once with `ignore_changes`, or a KMS-backed KEK) in the same change. Until that migration lands, operators MUST NOT scale the Deployment manually or add an HPA.

References:
- `SECURITY.md` §5 R-I13 ("App Deployment is locked to `replicas = 1`…") and §4 A15 (attack-path record).
- `openspec/specs/auth/spec.md` "Single-replica invariant" requirement.
