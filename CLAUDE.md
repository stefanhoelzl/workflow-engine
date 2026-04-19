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
- `TF_VAR_oauth2_client_id`, `TF_VAR_oauth2_client_secret` — GitHub OAuth App credentials

Non-secret inputs (`domain`, `oauth2_github_users`, `acme_email`) live in `infrastructure/envs/upcloud/cluster/terraform.tfvars`. K8s cluster config (`zone`, `kubernetes_version`, `node_plan`) is hardcoded as locals in `infrastructure/modules/kubernetes/upcloud/upcloud.tf`.

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
