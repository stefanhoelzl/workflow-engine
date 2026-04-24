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

Local stack: kind K8s cluster, Traefik (Helm), cert-manager (Helm, self-signed CA), S2 (local S3), workflow-engine app.
Accessible at `https://localhost:8443` (self-signed cert issued by an in-cluster CA; browser warns because the CA is not in the host trust store).

Secrets: copy `infrastructure/envs/local/local.secrets.auto.tfvars.example` to `local.secrets.auto.tfvars` and fill in OAuth2 credentials.

Prod/staging runbook: `docs/infrastructure.md`.

## Definition of Done

- `pnpm validate` must pass (runs lint, format check, type check, and tests)

## Dev verification

Agents verify most changes against `pnpm dev` (http://localhost:<port>), not the full cluster. `pnpm dev` boots the runtime, auto-uploads `workflows/src/demo.ts` to tenant `dev`, and hot-reloads on source changes — no kind cluster, no Traefik, no cert-manager.

**Escalate to `pnpm local:up:build` (https://localhost:8443) only when the change touches:** `infrastructure/`, Traefik routing/middleware, `secure-headers.ts` (CSP/HSTS/Permissions-Policy), `NetworkPolicy`, cert-manager, K8s manifests, or Helm values. Agents do NOT run `pnpm local:up:build` themselves; they write a `Cluster smoke (human)` block in `tasks.md` listing the specific probes for a human to run. Local auth (`/login`, the local-user dropdown, session-cookie flows) is NOT a cluster-escalation reason — the in-app local provider renders identically under `pnpm dev`.

### Spawn & readiness

1. Start backgrounded: `pnpm dev --random-port --kill`. Agents use `run_in_background` so the process tree is owned by the agent.
2. Grep stdout for the ready marker: `Dev ready on http://localhost:<port> (tenant=dev)`. Parse the port from that line. Do NOT probe before it appears — the port opens before the initial `runUpload` completes, so early curl will hit an empty registry.
3. Kill the process tree at end of task. `.persistence/` is left as-is between tasks; each boot re-uploads the bundle anyway.

### Auth fixture (set by `scripts/dev.ts`: `AUTH_ALLOW=local:dev,local:alice:acme,local:bob`, `LOCAL_DEPLOYMENT=1`)

- `/api/*`: `X-Auth-Provider: local` + `Authorization: User dev` — default happy path on tenant `dev`.
- Positive tenant isolation: `Authorization: User alice` against tenant `acme` → 200.
- Negative tenant isolation: `Authorization: User bob` against tenant `acme` → 404.
- `/webhooks/*`: public, no headers.
- UI routes (`/dashboard`, `/trigger`, `/login`): use `curl -c/-b cookiejar` against `POST /auth/local/signin` with form field `name=dev` to obtain the sealed `session` cookie, then send it on subsequent GETs. For interactive Alpine behaviour, use Playwright (below).

### Canonical fixture

`workflows/src/demo.ts` is the probe target. Its triggers: `runDemo` cron, http GET + POST under `/webhooks/dev/demo/*`, manual `fail` (exercises the `action.error` / `trigger.error` path). SDK or sandbox-stdlib changes must keep `demo.ts` in sync (see `## Example workflows`), so the probe surface stays stable.

### Probe toolkit

- **HTTP**: `curl` against `/api/workflows/dev`, `POST /webhooks/dev/demo/<trigger>`, `/dashboard`, `/dashboard/invocations`, `/trigger`. Assert on status code + JSON/HTML content.
- **EventStore**: inspect `.persistence/` for emitted events (`invocation.started`, `invocation.completed`, `trigger.request`, `action.error`, …). Useful when verifying tenant scoping or event-shape changes without a UI.
- **Dashboard HTML scraping**: grep rendered output for expected classes (`kind-trigger`, `kind-action`, `kind-rest`, `.entry.skeleton`) — cheap UI regression check without a browser.
- **Stdout tailing**: tee the dev process's stdout to a file; grep for error traces and upload confirmations.
- **Playwright** (agent-only; NOT in `pnpm test` / `pnpm validate`): use for Alpine-driven interactivity, focus rings, form submission, copy-event buttons. First-time use in a fresh clone requires `pnpm exec playwright install chromium` (~300 MB download, one-time). Scripts are ad-hoc via `pnpm exec playwright test -c <inline-config>` or `node -e '...'` — no test suite wiring.

### `openspec/changes/<id>/tasks.md` pattern (new changes only; archived changes stay as-is)

Replace the old "visit `https://localhost:8443` and click X" bullets with dev-probe bullets the agent ticks as it executes them. Example shape:

```
- [ ] N.1 `pnpm dev --random-port --kill` boots; stdout contains `Dev ready on http://localhost:<port> (tenant=dev)`.
- [ ] N.2 `GET /api/workflows/dev` (headers: `X-Auth-Provider: local`, `Authorization: User dev`) → 200 lists `demo`.
- [ ] N.3 `POST /webhooks/dev/demo/<trigger>` with <fixture body> → 202; `.persistence/` event stream shows paired `invocation.started` / `invocation.completed`.
- [ ] N.4 `GET /dashboard` (session cookie for `dev`) → 200; HTML contains `kind-trigger` and `kind-action` spans.
- [ ] N.5 (Alpine/interactivity only, if relevant) Playwright script: <click path + assertion>.

(If and only if the change touches edge/auth/infra:)
## Cluster smoke (human)
- [ ] `pnpm local:up:build`; `curl -k https://localhost:8443/` → 302 to `/trigger`; `/login` renders local-user dropdown; …
```

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
- **NEVER** add an authenticated UI route (`/dashboard`, `/trigger`, or any future authenticated UI prefix) without wiring `sessionMiddleware` into its middleware factory (§4).
- **NEVER** add an `/api/*` route without the `githubAuthMiddleware` in front of it (§4).
- **NEVER** accept a `<tenant>` URL parameter without validating against the tenant regex (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`) AND the `isMember(user, tenant)` predicate; both paths must fail-closed with a `404 Not Found` identical to "tenant does not exist" to prevent enumeration (§4).
- **NEVER** expose workflow or invocation data cross-tenant in API responses, dashboard queries, or trigger listings — every query must be scoped by `tenant`. For invocation events, the only scoped read API is `EventStore.query(tenant)` (do not construct raw queries against the `events` table); for workflows, route through `WorkflowRegistry`, which is keyed by tenant (§1 I-T2, §4).
- **NEVER** read `X-Auth-Request-*` on any code path. They are stripped by Traefik's `strip-auth-headers` middleware and ignored by every live middleware (`bearerUserMiddleware` explicitly asserts the headers are never read; `sessionMiddleware` reads only the sealed session cookie). Forward-auth identity was removed along with `headerUserMiddleware` by `replace-oauth2-proxy`; reading the headers anywhere would reintroduce the forged-header class (§4 A13).
- **NEVER** weaken the app-pod `NetworkPolicy` (§5 R-I1). It is defence-in-depth for the forged-header threat (the load-bearing controls are now app-side + edge-side, per §4 A13) and a baseline for blast radius on any future in-cluster compromise.
- **NEVER** hardcode or commit a secret; route all secrets through K8s Secrets injected via `envFrom.secretRef` (§5).
- **NEVER** log, emit, or store the `Authorization` header, session cookies, or OAuth secrets (§4).
- **NEVER** add a config field sourced from a K8s Secret without wrapping it in `createSecret()` at the zod field level (§5).
- **NEVER** add a K8s workload with `automountServiceAccountToken` enabled unless it has a dedicated `ServiceAccount` with scoped RBAC and a documented justification in `SECURITY.md` §5 / I11.
- **NEVER** add `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `'strict-dynamic'`, or a remote origin to the CSP in `secure-headers.ts` (§6).
- **NEVER** add an inline `<script>`, inline `<style>`, `on*=` event-handler attribute, `style=` attribute, string-form Alpine `:style` binding, or free-form `x-data` object literal to any HTML served by the runtime. All behaviour goes to `/static/*.js`; components are pre-registered via `Alpine.data(...)` (§6).
- **NEVER** remove the `LOCAL_DEPLOYMENT=1` HSTS gate; pinning HSTS on `localhost` breaks every other local dev service for up to a year (§6).
