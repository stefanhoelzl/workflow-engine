# Project Notes

## Tools

- Run `openspec` via: `pnpm exec openspec`
- Read `openspec/project.md` for architecture context

## Commands

- `pnpm lint` — Biome linter
- `pnpm check` — TypeScript type checking
- `pnpm test` — Vitest test suite (unit + integration, excludes WPT)
- `pnpm test:wpt` — WPT compliance suite (subtest-level report, separate from `pnpm test`)
- `pnpm test:wpt:refresh` — regenerate `packages/sandbox/test/wpt/vendor/` from upstream WPT
- `pnpm build` — Build runtime + workflows
- `pnpm start` — Build workflows and start runtime

## Upgrade notes

- **automate-prod-deployment** (BREAKING infrastructure var + workflow swap). Prod deploys are now CI-driven behind a required-reviewer gate on a `production` GitHub Environment, triggered by pushes to the long-lived `release` branch. The prod project's `image_tag` variable is replaced with `image_digest` (injected at apply time by CI), and `envs/prod/terraform.tfvars` no longer commits an image reference — the deployed image is defined by the `release` branch HEAD and the digest produced by the corresponding build. The old `.github/workflows/release.yml` (release-tag-triggered) is deleted; no new `vYYYY.MM.DD` calver tags are produced. Upgrade steps (no state wipe): (1) ensure the `release` branch exists (created from `main`) and is protected against force-push + deletion; (2) create the `production` GitHub Environment with at least one required reviewer; (3) add repo secrets `GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_SECRET_PROD` (plus the shared `AWS_*`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY` already used by staging); (4) after the change lands on `main`, fast-forward `release` to the merged `main` with `git push origin main:release` — the first `deploy-prod.yml` run performs the migration apply. Rollback: `git revert <bad-sha>` on `release` then push; no operator-side local `tofu apply` is sanctioned for routine deploys. The migration apply changes the container `image` string from `:<tag>` to `@<digest>` form, triggering a single pod rollout (same session-invalidation footprint as any prod deploy).
- **separate-app-projects** (BREAKING infrastructure layout). The `envs/upcloud/` subdirectory is removed. Four projects now live directly under `envs/`: `persistence/`, `cluster/`, `prod/`, `staging/`. State key `upcloud` is retired; cluster state uses the new key `cluster`, and `prod` + `staging` get their own state keys (`persistence` unchanged). The cluster project no longer knows about app instances — it provisions the K8s cluster, Traefik, cert-manager, and the ACME ClusterIssuer. Each app project creates its own namespace, Certificate (via the routes-chart), acme-solver NetworkPolicy, app workloads, and Dynu DNS record. Staging owns its own S3 bucket inside `envs/staging/`; prod reuses the persistence bucket via remote_state. Each app project holds its own UpCloud token (scoped to K8s-read) and re-fetches kubeconfig via its own `ephemeral "upcloud_kubernetes_cluster"` block. Upgrade steps (destroy + rebuild — ~20-25 min prod downtime): (1) run `tofu destroy` in the old `envs/upcloud/cluster/` to tear down K8s cluster + LB + cert-manager + app + DNS; (2) delete the `upcloud` S3 state object via the Object Storage UI; (3) register a second GitHub OAuth App for `staging.workflow-engine.webredirect.org/auth/github/callback`; (4) `tofu apply` the four new projects in order — persistence (no-op, already exists), cluster, prod, staging; (5) for staging's first apply, run the GHA `Deploy staging` workflow via `workflow_dispatch` to produce a bootstrap digest, then apply staging locally with `-var image_digest=<sha256:...>`. Persistence bucket + its contents survive the destroy. Subsequent staging deploys run automatically on push to `main` via `.github/workflows/deploy-staging.yml`.
- **add-cron-trigger** (additive — no breaking changes, no state wipe). Introduces the `cron` trigger kind: SDK `cronTrigger({schedule, tz?, handler})`, manifest entry `{type:"cron", schedule, tz, inputSchema, outputSchema}`, runtime `TriggerSource<"cron">`. The manifest schema is widened (new discriminant value), so existing HTTP-only tenant bundles remain valid without re-upload. Tenants adopting cron must rebuild and re-upload via `wfe upload --tenant <name>` to pick up the new SDK factory. Single-instance assumption applies (horizontal scaling would double-fire every tick; out of scope for v1).
- **generalize-triggers** (BREAKING manifest + executor API). Trigger manifest entries now require `inputSchema` + `outputSchema` JSON Schemas (the old `schema` field is replaced). The SDK synthesises both from `httpTrigger()` config; workflow authors do not change their source. The runtime gains a `TriggerSource` plugin contract — per-kind sources plug into `WorkflowRegistry` and receive `reconfigure(kindView)` on every state change. The HTTP source owns `/webhooks/*` routing directly; `WorkflowRegistry.lookup()` is removed in favour of `registry.list(tenant)`. `executor.invoke` is now `invoke(tenant, workflow, descriptor, input, bundleSource) -> Promise<{ ok: true, output } | { ok: false, error }>` (kind-agnostic envelope). `InvocationEvent` shape is unchanged — `pending/` and `archive/` do NOT need to be wiped. Upgrade steps: (1) wipe the `workflows/` prefix on the storage backend; (2) rebuild workflows with the new SDK; (3) re-upload each tenant via `wfe upload --tenant <name>`.
- **bake-action-names-drop-trigger-shim** (BREAKING, SDK surface + bundle shape). `httpTrigger({...})` now returns a callable instead of an object; `.handler` is no longer a public property on `Action` or `HttpTrigger`; `action({...})` requires `name` (the vite-plugin AST-injects it for `export const X = action({...})` declarations). The runtime no longer appends `__trigger_<name>` shim source or per-action `__setActionName` binder source. Existing tenant workflow tarballs must be **re-uploaded** after redeploy because the SDK shipped inside the bundle changed shape — old bundles have trigger-as-object and unnamed actions that the new runtime cannot dispatch. Re-upload via `wfe upload --tenant <name>` after deploy.
- **monotonic-event-timestamps** (event shape changed: `ts` is now per-run µs, new `at` field carries wall-clock ISO). Upgrading past this change requires wiping the `pending/` and `archive/` prefixes under the storage backend; the in-memory DuckDB index rebuilds on its own from the (now-empty) archive.
- **multi-tenant-workflows** (BREAKING). Every `InvocationEvent` now carries a required `tenant` field, the tenant-manifest format changes (root `{ workflows: [...] }`), and URLs change: upload is `POST /api/workflows/<tenant>`, webhooks are `/webhooks/<tenant>/<workflow-name>/<trigger-path>`. Bundle bootstrap no longer reads `WORKFLOW_DIR` / `WORKFLOWS_DIR`; runtime loads tenants from `workflows/<tenant>.tar.gz` on the storage backend. Upgrade steps: (1) wipe `pending/`, `archive/`, and `workflows/` prefixes on the storage backend; (2) remove `WORKFLOW_DIR` / `WORKFLOWS_DIR` from env/manifests; (3) after redeploy, re-upload each tenant via `wfe upload --tenant <name>`.

## Infrastructure (OpenTofu + kind)

Prerequisites: OpenTofu >= 1.11, Podman

- `pnpm local:up` — create/update local environment
- `pnpm local:up:build` — rebuild app image + create/update local environment
- `pnpm local:destroy` — tear down local environment

Local stack: kind K8s cluster, Traefik (Helm), cert-manager (Helm, self-signed CA), S2 (local S3), oauth2-proxy, workflow-engine app.
Accessible at `https://localhost:8443` (self-signed cert issued by an in-cluster CA; browser warns because the CA is not in the host trust store).

Secrets: copy `infrastructure/envs/local/local.secrets.auto.tfvars.example` to `local.secrets.auto.tfvars` and fill in OAuth2 credentials.

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
| `prod/`       | K8s read (ephemeral block re-fetch)      | `TF_VAR_dynu_api_key`, `TF_VAR_github_oauth_client_id`, `TF_VAR_github_oauth_client_secret`, plus `image_digest` supplied at apply time |
| `staging/`    | K8s read + Object Storage (own bucket)   | same as prod, plus `image_digest` supplied at apply time                           |

Non-secret tfvars committed in each project's `terraform.tfvars`:
- `cluster/`: `acme_email`
- `prod/`: `domain`, `auth_allow`
- `staging/`: `domain`, `auth_allow`, `service_uuid`, `service_endpoint`, `bucket_name`

K8s cluster config (`zone`, `kubernetes_version`, `node_plan`, `node_cidr`) is hardcoded as locals in `infrastructure/modules/kubernetes/upcloud/upcloud.tf`.

### Apply order (one-time)

1. `tofu -chdir=infrastructure/envs/persistence apply` — prod bucket + scoped user
2. `tofu -chdir=infrastructure/envs/cluster apply` — cluster, Traefik, cert-manager, ClusterIssuer (~12-17 min)
3. `tofu -chdir=infrastructure/envs/prod apply` — prod namespace, Certificate, app, DNS
4. Bootstrap staging: trigger the `Deploy staging` GHA workflow via `workflow_dispatch` to capture a digest, then locally run `tofu -chdir=infrastructure/envs/staging apply -var image_digest=sha256:...`

### Subsequent deploys

- **Prod** (CI-driven with approval gate): every push to the long-lived `release` branch triggers `.github/workflows/deploy-prod.yml`. Two-job split: (1) `plan` builds + pushes `ghcr.io/<repo>:release`, captures the digest, and renders `tofu plan` into the run's Summary; (2) `apply` declares `environment: production`, pauses for required-reviewer approval, then runs `tofu apply -var image_digest=<digest>` on `envs/prod/`, fetches kubeconfig via `upctl`, and blocks on `kubectl wait` for the prod Certificate. Cherry-pick workflow: `git cherry-pick <sha>` onto a local `release` checkout, `git push origin release`, approve the pending run in the Actions tab. Required repo secrets: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_SECRET_PROD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Rollback: `git revert <bad-sha>` on `release`, then `git push origin release` → workflow rebuilds prior code and redeploys. The `release` branch is protected against force-push and deletion.
- **Staging** (CI-driven): every push to `main` triggers `.github/workflows/deploy-staging.yml`, which builds + pushes `ghcr.io/<repo>:main`, captures the digest from `docker/build-push-action`, and runs `tofu apply` on `envs/staging/` with the digest. Required repo secrets: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `TF_VAR_OAUTH2_CLIENT_ID`, `TF_VAR_OAUTH2_CLIENT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

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

## Definition of Done

- `pnpm validate` must pass (runs lint, format check, type check, and tests)

## Code Conventions

- All relative imports must use `.js` extensions (required by `verbatimModuleSyntax`)
- Use `z.exactOptional()` not `.optional()` for optional Zod fields (`exactOptionalPropertyTypes` is enabled)
- Factory functions over classes. Closures for private state.
- Named exports only. Separate `export type {}` from value exports. Exception: data-only modules whose filename already conveys identity (e.g. `skip.ts`) may use `export default`.
- `biome-ignore` comments must have a good reason suffix. Write code that doesn't need them. Remove any that lack justification.

## Security Invariants

Full threat model: `/SECURITY.md`. Consult it before writing security-sensitive code.

- **NEVER** add a global, host-bridge API, or Node.js surface to the QuickJS sandbox without extending the §2 allowlist in the same PR (§2).
- **NEVER** add a `__*`-prefixed global to the sandbox without a capture-and-delete shim — guest code must not be able to read or overwrite raw host bridges (§2).
- **NEVER** add authentication to `/webhooks/*` — public ingress is intentional (§3).
- **NEVER** add a UI route (`/dashboard`, `/trigger`, or any future authenticated UI prefix) without confirming oauth2-proxy forward-auth covers it at Traefik (§4).
- **NEVER** add an `/api/*` route without the `githubAuthMiddleware` in front of it (§4).
- **NEVER** accept a `<tenant>` URL parameter without validating against the tenant regex (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`) AND the `isMember(user, tenant)` predicate; both paths must fail-closed with a `404 Not Found` identical to "tenant does not exist" to prevent enumeration (§4).
- **NEVER** expose workflow or invocation data cross-tenant in API responses, dashboard queries, or trigger listings — every query must be scoped by `tenant`. For invocation events, the only scoped read API is `EventStore.query(tenant)` (do not construct raw queries against the `events` table); for workflows, route through `WorkflowRegistry`, which is keyed by tenant (§1 I-T2, §4).
- **NEVER** read `X-Auth-Request-*` on any code path reachable from `/api/*`, `/webhooks/*`, `/static/*`, or any non-UI route. They are stripped by Traefik's `strip-auth-headers` middleware and ignored by `bearerUserMiddleware`; reading them anywhere else would break both guards simultaneously. The only legitimate reader is `headerUserMiddleware` on `/dashboard` and `/trigger` (§4 A13).
- **NEVER** weaken the app-pod `NetworkPolicy` (§5 R-I1). It is defence-in-depth for the forged-header threat (the load-bearing controls are now app-side + edge-side, per §4 A13) and a baseline for blast radius on any future in-cluster compromise.
- **NEVER** hardcode or commit a secret; route all secrets through K8s Secrets injected via `envFrom.secretRef` (§5).
- **NEVER** log, emit, or store the `Authorization` header, session cookies, or OAuth secrets (§4).
- **NEVER** add a config field sourced from a K8s Secret without wrapping it in `createSecret()` at the zod field level (§5).
- **NEVER** add a K8s workload with `automountServiceAccountToken` enabled unless it has a dedicated `ServiceAccount` with scoped RBAC and a documented justification in `SECURITY.md` §5 / I11.
- **NEVER** add `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `'strict-dynamic'`, or a remote origin to the CSP in `secure-headers.ts` (§6).
- **NEVER** add an inline `<script>`, inline `<style>`, `on*=` event-handler attribute, `style=` attribute, string-form Alpine `:style` binding, or free-form `x-data` object literal to any HTML served by the runtime. All behaviour goes to `/static/*.js`; components are pre-registered via `Alpine.data(...)` (§6).
- **NEVER** remove the `LOCAL_DEPLOYMENT=1` HSTS gate; pinning HSTS on `localhost` breaks every other local dev service for up to a year (§6).
