# Project Notes

## Tools

- Run `openspec` via: `pnpm exec openspec`
- Read `openspec/project.md` for architecture context

## Commands

- `pnpm lint` — Biome linter
- `pnpm check` — TypeScript type checking
- `pnpm test` — Vitest test suite (unit + integration, excludes WPT)
- `pnpm test:wpt` — WPT compliance suite (subtest-level report, separate from `pnpm test`)
- `pnpm test:wpt:refresh` — regenerate `packages/sandbox-stdlib/test/wpt/vendor/` from upstream WPT
- `pnpm build` — Build runtime + workflows
- `pnpm start` — Build workflows and start runtime

## Upgrade notes

- **fix-http-trigger-url** (BREAKING SDK surface + manifest; no state wipe). Makes the webhook URL mechanical — `/webhooks/<tenant>/<workflow>/<export-name>` — and strips all structured data from it. Eliminates a silent-conflict class: two `httpTrigger({...})` exports in one workflow that shared a `path:` used to resolve non-deterministically at request time (registration-order wins); JS export-name uniqueness now makes the collision impossible. Code-size bonus: ~230 lines gone (URLPattern, conditional-type plumbing, query parsing + schema path). SDK surface: `httpTrigger({ method?, body?, handler })`. `path`, `params`, and `query` are removed — build error if passed. `payload.params` and `payload.query` removed — type error if read. Handlers that need a query-string value must parse `new URL(payload.url).searchParams` explicitly (opt-in, unvalidated). Export identifiers must match `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`. Manifest narrows: HTTP trigger entries lose `path`, `params`, and `query`; old tarballs are rejected at upload. Re-upload each tenant after redeploy. SECURITY.md §3 updated in the same change: W8 threat row and R-W6 residual-risk row deleted; URLPattern mitigation replaced with a positive "Closed URL vocabulary" mitigation; payload snippet narrowed to `{ body, headers, url, method }`.
- **generalize-trigger-backends** (BREAKING internal runtime contract + BREAKING upload-API response shape on failure; NO tenant re-upload required, NO state wipe). Reshapes the `TriggerSource` plugin contract: `reconfigure(view)` → `reconfigure(tenant, entries): Promise<ReconfigureResult>` where each `TriggerEntry` carries `{descriptor, fire}` and the `fire` closure (constructed by the registry via `buildFire`) encapsulates input validation + executor dispatch. Backends never import or call the executor. A new `workflowName: string` field is added to every `BaseTriggerDescriptor` so backends can key per-tenant state by `(tenant, workflowName, triggerName)`; the registry fills it in during descriptor build. The upload API (`POST /api/workflows/<tenant>`) classifies failures: 422 for manifest/unknown-kind (unchanged semantics, now also fires when a manifest-declared kind has no matching registered backend); 400 with `{error: "trigger_config_failed", errors: [...]}` when any backend returns `{ok: false}` during reconfigure (e.g., future IMAP bad-credentials); 500 with `{error: "trigger_backend_failed", errors: [...]}` when any backend throws (infra failure); 400 with both `errors` and `infra_errors` when both classes occur. Backends run in parallel via `Promise.allSettled`; there is NO rollback on partial failure, and the tarball is NOT persisted unless every backend returns `{ok: true}` — a failed upload may leave live backend state divergent from storage until the tenant re-uploads (explicit non-guarantee). In-flight fires keep running against their captured closures across subsequent reconfigures (no draining, no cancellation). Upgrade steps (no-op for tenants): (1) deploy the change; (2) done. Bundle format, sandbox boundary, manifest schema, pending/archive state, and storage layout are unchanged. The only client-visible change is the 4xx/5xx response shape on failed upload; the `wfe upload` CLI continues to treat non-2xx as failure.
- **sandbox-plugin-architecture** (BREAKING SDK surface + bundle shape + sandbox factory signature; pending/archive NOT wiped). Collapses every ad-hoc `__*` raw bridge into a uniform plugin architecture. The sandbox core is now a pure mechanism (WASM hosting, plugin composition, event stamping of intrinsic fields, WASI routing, run lifecycle); every host-callable surface (fetch, timers, console, web-platform polyfills, action dispatch, trigger lifecycle, WASI telemetry) ships as a Plugin loaded via `data:` URI from a vite-bundled source string. Public changes: (1) `sandbox()` factory signature is `{ source, plugins, filename?, memoryLimit?, logger? }` — `methods`, `onEvent` factory option, `fetch`, and `RunOptions` metadata are gone; (2) SDK `action()` calls `globalThis.__sdk.dispatchAction(name, input, handler, completer)` instead of `globalThis.__dispatchAction(..., outputSchema)`; `__sdk` is installed as a locked global (`Object.defineProperty({writable:false, configurable:false})` wrapping a frozen inner `{dispatchAction}`) by the sdk-support plugin's Phase-2 source; the underlying `__hostCallAction` + `__emitEvent` bridges are captured into the dispatcher IIFE and deleted by Phase-3 before tenant code runs; (3) `sb.run(name, ctx)` takes no metadata options and rejects if a previous run is still in flight — the runtime executor serializes per `(tenant, sha)` and stamps `id/tenant/workflow/workflowSha` onto every event in its `sb.onEvent` receiver before forwarding to the bus (SECURITY.md §2 R-8). Events cross the sandbox/runtime boundary as `SandboxEvent` (kind/seq/ref/at/ts/name/input/output/error); `InvocationEvent extends SandboxEvent` and is only visible downstream of the executor. Packaging: new `@workflow-engine/sandbox-stdlib` package (web-platform polyfills, fetch with `hardenedFetch` structural default, timers, console, WPT suite); runtime owns `createTriggerPlugin`, `createHostCallActionPlugin`, `wasi-telemetry` plugin; SDK owns `createSdkSupportPlugin`. Dashboard's flamegraph `BarKind` narrowed to `"trigger" | "action" | "rest"` with open-ended marker kinds; `system.call` renders as `wasi.clock_time_get` / `wasi.random_get`. SECURITY.md §2 rewritten from per-shim invariants to 8 plugin-discipline rules (R-1 through R-8). Upgrade steps: (1) `pending/`, `archive/`, and state keys NOT wiped; (2) rebuild workflows via `pnpm build` (bundles now call `__sdk.dispatchAction`); (3) re-upload each tenant via `wfe upload --tenant <name>` — old bundles call `__dispatchAction(..., outputSchema)` which the new sandbox no longer installs and will throw `No action dispatcher installed` on first invocation.
- **guard-infra-drift** (additive — no breaking changes, no state wipe). Introduces `.github/workflows/plan-infra.yml`: every PR to `main` runs `tofu plan -detailed-exitcode -lock=false` against `envs/cluster/` and `envs/persistence/`; a non-empty plan fails the check and blocks merge. No new secrets; reuses `AWS_*`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`. Apply for these two projects remains operator-driven; this change only guards that `main` equals live state at merge time. GitHub config migrations bundled in: the existing `main` ruleset's `required_status_checks` rule now also lists `plan (cluster)` and `plan (persistence)` (alongside pre-existing `ci`, `docker-build`, `wpt`), with `bypass_actors: []` — no per-PR admin bypass; the legacy `release` branch protection is replaced by a new `release` ruleset (rules: `deletion`, `non_fast_forward`, no bypass); the obsolete `releases` tag ruleset (left over from the retired calver-tag mechanism) is deleted. Upgrade steps for a fresh environment: (1) locally confirm `tofu plan` is empty for both cluster and persistence before opening the workflow PR; (2) open the PR (workflow runs on its own head branch and reports both new check contexts); (3) update the `main` ruleset to add the two contexts (`gh api --method PUT repos/:owner/:repo/rulesets/<id>`), create the `release` ruleset, delete any `releases` tag ruleset. Escape hatch if the gate breaks: secret rotation via `gh secret set`, or temporary ruleset `enforcement: "disabled"` for workflow-file regressions (see "Operator flow for manual infrastructure projects" under `## Production`).
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

- **NEVER** add a Node.js surface, or a new guest-visible global, to the QuickJS sandbox without extending §2's "Globals surface" list in the same PR, with a threat assessment (§2).
- **NEVER** add a `GuestFunctionDescription` with `public: true` without a written rationale — descriptors default to `public: false` so phase-3 auto-deletes them from `globalThis` after plugin source eval (§2 R-1).
- **NEVER** install a top-level host-callable global for guest use without locking it via `Object.defineProperty({writable: false, configurable: false})` wrapping a frozen inner object; canonical example is `__sdk` (§2 R-2).
- **NEVER** override `createFetchPlugin`'s default `hardenedFetch` in production composition; overriding is a test-only path via `__pluginLoaderOverride` (§2 R-3).
- **NEVER** add a plugin with long-lived state (timers, pending `Callable`s, in-flight fetches) without an `onRunFinished` that routes cleanup through the same path as guest-initiated teardown so audit events fire (§2 R-4).
- **NEVER** mutate `bridge.*` or construct `seq`/`ref`/`ts`/`at`/`id` directly from plugin code — all events flow through `ctx.emit` / `ctx.request`, which stamp those fields internally (§2 R-5).
- **NEVER** introduce cross-thread method calls between main and worker; plugin code is worker-only and plugin configs MUST be JSON-serializable (verified by `assertSerializableConfig`) (§2 R-6).
- **NEVER** use the reserved event prefixes `trigger`, `action`, `fetch`, `timer`, `console`, `wasi`, or `uncaught-error` for third-party plugins; use a domain-specific prefix instead (§2 R-7).
- **NEVER** stamp tenant, workflow, workflowSha, or invocationId inside sandbox or plugin code — the sandbox only stamps intrinsic event fields, and the runtime attaches runtime metadata in its `sb.onEvent` receiver before forwarding to the bus (§2 R-8).
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
