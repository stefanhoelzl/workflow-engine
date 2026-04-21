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

- **add-cron-trigger** (additive — no breaking changes, no state wipe). Introduces the `cron` trigger kind: SDK `cronTrigger({schedule, tz?, handler})`, manifest entry `{type:"cron", schedule, tz, inputSchema, outputSchema}`, runtime `TriggerSource<"cron">`. The manifest schema is widened (new discriminant value), so existing HTTP-only tenant bundles remain valid without re-upload. Tenants adopting cron must rebuild and re-upload via `wfe upload --tenant <name>` to pick up the new SDK factory. Single-instance assumption applies (horizontal scaling would double-fire every tick; out of scope for v1).
- **generalize-triggers** (BREAKING manifest + executor API). Trigger manifest entries now require `inputSchema` + `outputSchema` JSON Schemas (the old `schema` field is replaced). The SDK synthesises both from `httpTrigger()` config; workflow authors do not change their source. The runtime gains a `TriggerSource` plugin contract — per-kind sources plug into `WorkflowRegistry` and receive `reconfigure(kindView)` on every state change. The HTTP source owns `/webhooks/*` routing directly; `WorkflowRegistry.lookup()` is removed in favour of `registry.list(tenant)`. `executor.invoke` is now `invoke(tenant, workflow, descriptor, input, bundleSource) -> Promise<{ ok: true, output } | { ok: false, error }>` (kind-agnostic envelope). `InvocationEvent` shape is unchanged — `pending/` and `archive/` do NOT need to be wiped. Upgrade steps: (1) wipe the `workflows/` prefix on the storage backend; (2) rebuild workflows with the new SDK; (3) re-upload each tenant via `wfe upload --tenant <name>`.
- **bake-action-names-drop-trigger-shim** (BREAKING, SDK surface + bundle shape). `httpTrigger({...})` now returns a callable instead of an object; `.handler` is no longer a public property on `Action` or `HttpTrigger`; `action({...})` requires `name` (the vite-plugin AST-injects it for `export const X = action({...})` declarations). The runtime no longer appends `__trigger_<name>` shim source or per-action `__setActionName` binder source. Existing tenant workflow tarballs must be **re-uploaded** after redeploy because the SDK shipped inside the bundle changed shape — old bundles have trigger-as-object and unnamed actions that the new runtime cannot dispatch. Re-upload via `wfe upload --tenant <name>` after deploy.
- **monotonic-event-timestamps** (event shape changed: `ts` is now per-run µs, new `at` field carries wall-clock ISO). Upgrading past this change requires wiping the `pending/` and `archive/` prefixes under the storage backend; the in-memory DuckDB index rebuilds on its own from the (now-empty) archive.
- **multi-tenant-workflows** (BREAKING). Every `InvocationEvent` now carries a required `tenant` field, the tenant-manifest format changes (root `{ workflows: [...] }`), and URLs change: upload is `POST /api/workflows/<tenant>`, webhooks are `/webhooks/<tenant>/<workflow-name>/<trigger-path>`. Bundle bootstrap no longer reads `WORKFLOW_DIR` / `WORKFLOWS_DIR`; runtime loads tenants from `workflows/<tenant>.tar.gz` on the storage backend. Upgrade steps: (1) wipe `pending/`, `archive/`, and `workflows/` prefixes on the storage backend; (2) remove `WORKFLOW_DIR` / `WORKFLOWS_DIR` from env/manifests; (3) after redeploy, re-upload each tenant via `wfe upload --tenant <name>`.
- **replace-oauth2-proxy** (BREAKING, auth model + env + infra). The oauth2-proxy sidecar is removed entirely; authentication runs in-process (`packages/runtime/src/auth/*`). Env changes: `GITHUB_USER` → `AUTH_ALLOW` with the new grammar `github:user:<login>;github:org:<org>;…` (semicolon-separated, provider-prefixed); adds `GITHUB_OAUTH_CLIENT_ID` (plain) + `GITHUB_OAUTH_CLIENT_SECRET` (secret); `BASE_URL` becomes required when `AUTH_ALLOW` is set. Terraform vars renamed: `oauth2_github_users` → `auth_allow`, `oauth2_client_id` → `github_oauth_client_id`, `oauth2_client_secret` → `github_oauth_client_secret`. OAuth scope is bumped to `user:email read:org` (users will see a one-time consent re-prompt on first post-deploy login). The app Deployment is now load-bearing `replicas = 1`: the session-cookie sealing password lives in memory and is not shared across pods. Manual one-time operator step in **both** prod and each developer's local GitHub OAuth App: before apply, **add** the new callback URL `https://<domain>/auth/github/callback` to the authorized callback URL list (keep the old `.../oauth2/callback` entry during the cutover window); after verification, remove the old entry. All existing oauth2-proxy session cookies become unreadable at cutover; users re-auth through the in-app flow with one click. Dashboard/trigger "Sign out" becomes a `POST /auth/logout` form-button (was GET link to `/oauth2/sign_out`).

## Infrastructure (OpenTofu + kind)

Prerequisites: OpenTofu >= 1.11, Podman

- `pnpm local:up` — create/update local environment
- `pnpm local:up:build` — rebuild app image + create/update local environment
- `pnpm local:destroy` — tear down local environment

Local stack: kind K8s cluster, Traefik (Helm), cert-manager (Helm, self-signed CA), S2 (local S3), workflow-engine app (auth runs in-process).
Accessible at `https://localhost:8443` (self-signed cert issued by an in-cluster CA; browser warns because the CA is not in the host trust store).

Secrets: copy `infrastructure/envs/local/local.secrets.auto.tfvars.example` to `local.secrets.auto.tfvars` and fill in GitHub OAuth credentials.

GitHub OAuth App setup for local dev (one-time, per developer): create an OAuth App at https://github.com/settings/developers with Homepage URL `https://localhost:8443` and Authorization callback URL `https://localhost:8443/auth/github/callback`. Copy the client id + secret into `local.secrets.auto.tfvars`.

## Production (OpenTofu + UpCloud)

Prerequisites: OpenTofu >= 1.11, UpCloud account, Dynu DNS domain

Three separate tokens with least-privilege. State credentials via `AWS_*` (S3 backend requirement), everything else via `TF_VAR_*`:

Shared by both projects (state backend, scoped to `tofu-state` bucket only):
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — S3 state backend credentials
- `TF_VAR_state_passphrase` — passphrase for client-side state encryption (AES-GCM)

Persistence project (`infrastructure/envs/upcloud/persistence/`):
- `TF_VAR_upcloud_token` — UpCloud API token (Object Storage permissions)

Cluster project (`infrastructure/envs/upcloud/cluster/`):
- `TF_VAR_upcloud_token` — UpCloud API token (K8s + networking permissions)
- `TF_VAR_dynu_api_key` — Dynu DNS API key
- `TF_VAR_github_oauth_client_id`, `TF_VAR_github_oauth_client_secret` — GitHub OAuth App credentials

Non-secret inputs (`domain`, `auth_allow`, `acme_email`) live in `infrastructure/envs/upcloud/cluster/terraform.tfvars`. K8s cluster config (`zone`, `kubernetes_version`, `node_plan`) is hardcoded as locals in `infrastructure/modules/kubernetes/upcloud/upcloud.tf`.

Before `tofu apply` on the prod cluster, ensure the prod GitHub OAuth App's authorized callback URLs include `https://workflow-engine.webredirect.org/auth/github/callback`. Keep the old `.../oauth2/callback` entry until after the new flow is verified post-deploy; then remove it. GitHub allows multiple authorized callback URLs during a cutover.

Note: `TF_VAR_upcloud_token` is set to a different scoped token per project.
State bucket and endpoint are hardcoded in backend configs.

One-time setup:
1. Create UpCloud Object Storage instance via console
2. Create admin user + access key + `terraform-state` bucket
3. Register GitHub OAuth App for `workflow-engine.webredirect.org`

Deploy:
1. `cd infrastructure/envs/upcloud/persistence && tofu init && tofu apply` — creates app bucket + scoped user
2. `cd infrastructure/envs/upcloud/cluster && tofu init && tofu apply` — creates K8s cluster + installs cert-manager + deploys app + issues Let's Encrypt cert + sets DNS

`tofu apply` returns once the cert-manager Helm release is Ready. Cert issuance happens asynchronously over the next 30-90s (ACME HTTP-01). To block until the cert is actually served, run this after apply:

```
kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m
```

Failure of that wait means DNS, port 80 reachability, CAA records, or another prerequisite is misconfigured — inspect via `kubectl describe certificate prod-workflow-engine -n prod`.

**cert-manager chart upgrades**: `installCRDs=true` installs CRDs only on first release install, not on subsequent Helm upgrades. When bumping the cert-manager chart version in `infrastructure/modules/cert-manager/cert-manager.tf`, first apply the new CRDs manually:

```
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/<new-version>/cert-manager.crds.yaml
```

then run `tofu apply` to upgrade the Helm release.

Accessible at `https://workflow-engine.webredirect.org` (Let's Encrypt TLS, cert-manager-managed).

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
- **NEVER** bypass `hardenedFetch` when exposing outbound HTTP to guest code. Any new code path that performs a host-side `fetch` or `request` on behalf of a sandbox MUST route through `packages/sandbox/src/hardened-fetch.ts` (IANA private-range block + DNS validation + manual redirect re-check + 30s timeout + fail-closed sanitized error). `SandboxOptions.fetch` defaults to `hardenedFetch`; the only permitted override is a test mock (§2 R-S4).
- **NEVER** weaken the IANA special-use blocklist in `packages/sandbox/src/hardened-fetch.ts` (the `BLOCKED_CIDRS_IPV4` / `BLOCKED_CIDRS_IPV6` constants) without a written security rationale in the same PR that updates `SECURITY.md §2 R-S4` and the corresponding `Hardened outbound fetch` requirement in `openspec/specs/sandbox/spec.md` (§2 R-S4).
- **NEVER** add authentication to `/webhooks/*` — public ingress is intentional (§3).
- **NEVER** add a UI route (`/dashboard`, `/trigger`, or any future authenticated UI prefix) without wiring `sessionMiddleware` into its middleware factory (§4).
- **NEVER** add an `/api/*` route without the `githubAuthMiddleware` in front of it (§4).
- **NEVER** accept a `<tenant>` URL parameter without validating against the tenant regex (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`) AND the `isMember(user, tenant)` predicate; both paths must fail-closed with a `404 Not Found` identical to "tenant does not exist" to prevent enumeration (§4).
- **NEVER** expose workflow or invocation data cross-tenant in API responses, dashboard queries, or trigger listings — every query must be scoped by `tenant`. For invocation events, the only scoped read API is `EventStore.query(tenant)` (do not construct raw queries against the `events` table); for workflows, route through `WorkflowRegistry`, which is keyed by tenant (§1 I-T2, §4).
- **NEVER** read `X-Auth-Request-*`, `X-Forwarded-User`, or any forward-auth-style header on any code path. No upstream produces them; reading them would reintroduce the A13 threat class (§4 A13).
- **NEVER** raise the `workflow-engine` app Deployment replicas above 1 without first migrating the auth sealing password out of in-memory state (§4 A15, §5 R-I13).
- **NEVER** accept the session cookie on `/api/*`; the API is Bearer-only by design (§4).
- **NEVER** persist the JWE sealing password (disk, K8s Secret, log, telemetry, env) — it MUST regenerate in-memory at every process start (§4).
- **NEVER** weaken the app-pod `NetworkPolicy` (§5 R-I1). It is defence-in-depth for the forged-header threat (the load-bearing controls are now app-side + edge-side, per §4 A13) and a baseline for blast radius on any future in-cluster compromise.
- **NEVER** hardcode or commit a secret; route all secrets through K8s Secrets injected via `envFrom.secretRef` (§5).
- **NEVER** log, emit, or store the `Authorization` header, session cookies, or OAuth secrets (§4).
- **NEVER** add a config field sourced from a K8s Secret without wrapping it in `createSecret()` at the zod field level (§5).
- **NEVER** add a K8s workload with `automountServiceAccountToken` enabled unless it has a dedicated `ServiceAccount` with scoped RBAC and a documented justification in `SECURITY.md` §5 / I11.
- **NEVER** add `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `'strict-dynamic'`, or a remote origin to the CSP in `secure-headers.ts` (§6).
- **NEVER** add an inline `<script>`, inline `<style>`, `on*=` event-handler attribute, `style=` attribute, string-form Alpine `:style` binding, or free-form `x-data` object literal to any HTML served by the runtime. All behaviour goes to `/static/*.js`; components are pre-registered via `Alpine.data(...)` (§6).
- **NEVER** remove the `LOCAL_DEPLOYMENT=1` HSTS gate; pinning HSTS on `localhost` breaks every other local dev service for up to a year (§6).
