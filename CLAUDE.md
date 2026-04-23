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

## Infrastructure (OpenTofu + kind)

Prerequisites: OpenTofu >= 1.11, Podman

- `pnpm local:up` — create/update local environment
- `pnpm local:up:build` — rebuild app image + create/update local environment
- `pnpm local:destroy` — tear down local environment

Local stack: kind K8s cluster, Traefik (Helm), cert-manager (Helm, self-signed CA), S2 (local S3), oauth2-proxy, workflow-engine app.
Accessible at `https://localhost:8443` (self-signed cert issued by an in-cluster CA; browser warns because the CA is not in the host trust store).

Secrets: copy `infrastructure/envs/local/local.secrets.auto.tfvars.example` to `local.secrets.auto.tfvars` and fill in OAuth2 credentials.

Prod/staging runbook: `docs/infrastructure.md`.

## Definition of Done

- `pnpm validate` must pass (runs lint, format check, type check, and tests)

## Example workflows

`workflows/src/demo.ts` is the canonical authoring reference. Keep it in sync with any SDK surface or sandbox-stdlib change. It showcases:

- SDK: `defineWorkflow({env})`, `env()`, `action` composition (action calls action), `httpTrigger` (GET + POST, zod body, `.meta({example})`), `cronTrigger` (schedule + explicit IANA tz), `manualTrigger` (zod `input` + `output`)
- sandbox-stdlib: `fetch`, `crypto.subtle`, `crypto.randomUUID`, `setTimeout`, `URL` / `URLSearchParams`, `console`
- Failure path: `fail` manualTrigger invokes the `boom` action which throws, so the dashboard renders a real `action.error` / `trigger.error` pair.

Every non-failure trigger dispatches the same `runDemo` orchestrator so any kind can exercise the full surface. A change that touches SDK surface or workflow-authoring ergonomics without updating `demo.ts` is incomplete.

## Code Conventions

- All relative imports must use `.js` extensions (required by `verbatimModuleSyntax`)
- Use `z.exactOptional()` not `.optional()` for optional Zod fields (`exactOptionalPropertyTypes` is enabled)
- Factory functions over classes. Closures for private state.
- Named exports only. Separate `export type {}` from value exports. Exception: data-only modules whose filename already conveys identity (e.g. `skip.ts`) may use `export default`.
- `biome-ignore` comments must have a good reason suffix. Write code that doesn't need them. Remove any that lack justification.
- SDK surface or sandbox-stdlib changes must land with a matching update to `workflows/src/demo.ts` — see `## Example workflows`.

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
- **NEVER** emit, read, or construct `InvocationEvent.meta` (including `meta.dispatch`) from inside sandbox or plugin code — `meta` is stamped only by the executor's `sb.onEvent` widener, gated on `event.kind === "trigger.request"`. Dispatch provenance (`{source, user?}`) is a runtime-only concern; guests never see it (§2 R-9).
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
