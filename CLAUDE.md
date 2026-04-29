# Project Notes

## Tools

- Run `openspec` via: `pnpm exec openspec`
- Read `openspec/project.md` for architecture context

## Commands

- `pnpm lint` — Biome linter
- `pnpm check` — TypeScript type checking
- `pnpm test` — Vitest test suite (unit + integration, excludes WPT)
- `pnpm test:wpt` — WPT compliance suite (subtest-level report, separate from `pnpm test`); honours `WPT_CONCURRENCY` env override (default: `min(4, max(2, cpus / 2))` — capped low because each WPT file spawns its own QuickJS sandbox worker; the previous `max(4, cpus × 2)` default saturated dev machines).
- `pnpm test:wpt:refresh` — regenerate `packages/sandbox-stdlib/test/wpt/vendor/` from upstream WPT
- `pnpm build` — Recursively runs workspace builds (`pnpm -r build`): `vite build` (runtime → `dist/main.js`, sandbox) + `tsc --build` (sdk); workflows emit per-file `workflows/dist/<name>.js` only — no `manifest.json`, no `bundle.tar.gz`. The deployable tenant tarball is produced on-demand, in memory, by `wfe upload` (which calls the internal `bundle()` to seal secrets against the server pubkey before POSTing). Per-workspace: `pnpm --filter @workflow-engine/runtime build`, `pnpm --filter @workflow-engine/sandbox build`, `pnpm --filter @workflow-engine/sdk build`.
- `pnpm start` — `pnpm build` then `pnpm dev` (builds workspaces, then boots the dev runtime with auto-upload of `workflows/src/demo.ts`)

## CLI (`wfe`)

The SDK ships a `wfe` binary (`packages/sdk/package.json` → `bin`). Invoke it from the workflows project root via `pnpm exec`:

- `pnpm exec wfe upload --owner <name>` — build and upload the current project's bundle to the default URL.
- `pnpm exec wfe upload --owner <name> --url http://localhost:8080` — target local dev.
- `pnpm exec wfe upload --owner <name> --user <name>` — local-provider auth (requires server `LOCAL_DEPLOYMENT=1`).
- `pnpm exec wfe upload --owner <name> --token <ghp_…>` — github-provider auth (explicit token).
- `pnpm exec wfe upload --owner <name>` with `GITHUB_TOKEN=<ghp_…>` in the env — same as `--token`.

`--user`, `--token`, and `GITHUB_TOKEN` are mutually exclusive. The check runs *before* the build; a conflicting invocation fails fast and produces no artefacts (see SECURITY.md §4 "CLI authentication").

## Infrastructure (OpenTofu + kind)

Prerequisites: OpenTofu >= 1.11, Podman

- `pnpm local:up` — create/update local environment
- `pnpm local:up:build` — rebuild app image + create/update local environment
- `pnpm local:destroy` — tear down local environment

Local stack: kind K8s cluster, Traefik (Helm), cert-manager (Helm, self-signed CA), S2 (local S3), workflow-engine app.
Accessible at `https://localhost:8443` (self-signed cert issued by an in-cluster CA; browser warns because the CA is not in the host trust store).

Secrets: copy `infrastructure/envs/local/local.secrets.auto.tfvars.example` to `local.secrets.auto.tfvars` and fill in OAuth2 credentials.

Prod/staging runbook: `docs/infrastructure.md`.

**Pre-merge infra plan gate.** `.github/workflows/plan-infra.yml` plans `cluster`, `persistence`, `staging`, `prod` on every PR and all four are required checks. `cluster` and `persistence` use `changes-allowed: false` (exit 2 fails) — any change to `infrastructure/envs/{cluster,persistence}/` or modules they consume MUST be applied locally by the operator before the PR can merge (`tofu -chdir=infrastructure/envs/<project> apply`). When an agent touches those paths, surface the apply-first requirement to the user in its summary; do NOT run `tofu apply` yourself. Full flow in `docs/infrastructure.md` under "Pre-merge plan gate".

## Definition of Done

- `pnpm validate` must pass. Runs in parallel: `pnpm lint` (Biome), `pnpm check` (TypeScript), `pnpm test` (Vitest unit + integration; **excludes WPT** — run `pnpm test:wpt` separately when touching sandbox-stdlib), and `tofu fmt -check` + `tofu validate` for every infrastructure env.
- `pnpm test:e2e` is gated separately in CI (its own GitHub Actions job, not part of `validate` and not part of `pnpm test`). It builds the workspace then runs `vitest run --project tests` against a real spawned runtime child per `describe` block. Run it locally before pushing when the change touches runtime spawn/shutdown, the SDK CLI build/upload pipeline, persistence layout, plugin host-call surface (fetch/SQL/SMTP), authenticated UI routes, or anything else under `packages/tests/test/`. See `packages/tests/README.md` for the test-author surface.

## Dev verification

Agents verify most changes against `pnpm dev` (http://localhost:<port>), not the full cluster. `pnpm dev` boots the runtime, auto-uploads `workflows/src/demo.ts` and `workflows/src/demo-advanced.ts` under owner `local` (repos `demo` and `demo-advanced`), and hot-reloads on source changes — no kind cluster, no Traefik, no cert-manager.

**Escalate to `pnpm local:up:build` (https://localhost:8443) only when the change touches:** `infrastructure/`, Traefik routing/middleware, `secure-headers.ts` (CSP/HSTS/Permissions-Policy), `NetworkPolicy`, cert-manager, K8s manifests, or Helm values. Agents do NOT run `pnpm local:up:build` themselves; they write a `Cluster smoke (human)` block in `tasks.md` listing the specific probes for a human to run. Local auth (`/login`, the local-user dropdown, session-cookie flows) is NOT a cluster-escalation reason — the in-app local provider renders identically under `pnpm dev`.

### Spawn & readiness

1. Start backgrounded: `pnpm dev --random-port --kill`. Agents use `run_in_background` so the process tree is owned by the agent.
2. Grep stdout for the ready marker: `Dev ready on http://localhost:<port> (tenant=dev)`. Parse the port from that line — the literal `tenant=dev` is a stale legacy string emitted by `scripts/dev.ts:353`; the actual upload target is owner `local`, not `dev`. Do NOT probe before the marker appears — the port opens before the initial `runUpload` completes, so early curl will hit an empty registry.
3. Kill the process tree at end of task. `.persistence/` is left as-is between tasks; each boot re-uploads the bundle anyway.

### Auth fixture (set by `scripts/dev.ts`: `AUTH_ALLOW=local:local,local:alice:acme,local:bob`, `LOCAL_DEPLOYMENT=1`)

- `/api/*`: `X-Auth-Provider: local` + `Authorization: User local` — default happy path on owner `local`. Note: the only API routes registered today are `POST /api/workflows/<owner>/<repo>` (upload) and `GET /api/workflows/<owner>/public-key`. There is no `GET /api/workflows/<owner>` listing route; reach the workflow surface via `/dashboard/<owner>` (UI route, session cookie).
- Positive owner isolation: `Authorization: User alice` against owner `acme` → 200.
- Negative owner isolation: `Authorization: User bob` against owner `acme` → 404.
- `/webhooks/*`: public, no headers.
- UI routes (`/dashboard`, `/trigger`, `/login`): use `curl -c/-b cookiejar` against `POST /auth/local/signin` with form field `user=local` (NOT `name=local`; the handler reads `body.user`) to obtain the sealed `session` cookie, then send it on subsequent GETs. For interactive Alpine behaviour, use Playwright (below).

### Canonical fixture

`workflows/src/demo.ts` is the probe target. Its triggers: `runDemo` cron, http GET + POST under `/webhooks/local/demo/*`, manual `fail` (exercises the `action.error` / `trigger.error` path). SDK or sandbox-stdlib changes must keep `demo.ts` in sync (see `## Example workflows`), so the probe surface stays stable.

### Probe toolkit

- **HTTP**: `curl` against `POST /webhooks/local/demo/<trigger>` (public webhooks), `/dashboard/local/demo` (session cookie), `/trigger/local/demo` (session cookie). Assert on status code + JSON/HTML content. To list workflows or trigger names, scrape the dashboard HTML — there is no `GET /api/workflows/<owner>` JSON listing.
- **EventStore**: inspect `.persistence/` for emitted events (`invocation.started`, `invocation.completed`, `trigger.request`, `action.error`, …). Useful when verifying owner scoping or event-shape changes without a UI.
- **Dashboard HTML scraping**: grep rendered output for expected classes (`kind-trigger`, `kind-action`, `kind-rest`, `.entry.skeleton`) — cheap UI regression check without a browser.
- **Stdout tailing**: tee the dev process's stdout to a file; grep for error traces and upload confirmations.
- **Playwright** (agent-only; NOT in `pnpm test` / `pnpm validate`): use for Alpine-driven interactivity, focus rings, form submission, copy-event buttons. First-time use in a fresh clone requires `pnpm exec playwright install chromium` (~300 MB download, one-time). Scripts are ad-hoc via `pnpm exec playwright test -c <inline-config>` or `node -e '...'` — no test suite wiring.

### `openspec/changes/<id>/tasks.md` pattern (new changes only; archived changes stay as-is)

Replace the old "visit `https://localhost:8443` and click X" bullets with dev-probe bullets the agent ticks as it executes them. Example shape:

```
- [ ] N.1 `pnpm dev --random-port --kill` boots; stdout contains `Dev ready on http://localhost:<port> (tenant=dev)` (the `tenant=dev` literal is legacy — the actual upload target is owner `local`).
- [ ] N.2 `POST /auth/local/signin` (form: `user=local`) → 302 + `session` cookie. Health-check by hitting `/dashboard/local/demo` with that cookie → 200; HTML contains a `runDemo` trigger row.
- [ ] N.3 `POST /webhooks/local/demo/<trigger>` with <fixture body> → 202; `.persistence/` event stream shows paired `invocation.started` / `invocation.completed`.
- [ ] N.4 `GET /dashboard/local/demo` (session cookie for `local`) → 200; HTML contains `kind-trigger` and `kind-action` spans.
- [ ] N.5 (Alpine/interactivity only, if relevant) Playwright script: <click path + assertion>.

(If and only if the change touches edge/auth/infra:)
## Cluster smoke (human)
- [ ] `pnpm local:up:build`; `curl -k https://localhost:8443/` → 302 to `/trigger`; `/login` renders local-user dropdown; …
```
## Upgrade notes

See `docs/upgrades.md` for tenant rebuild/re-upload requirements per change.

## Example workflows

`workflows/src/demo.ts` is the canonical authoring reference. Keep it in sync with any SDK surface or sandbox-stdlib change. It showcases:

- SDK factories: `defineWorkflow({env})`, `env()`, `action` composition (action calls action), `httpTrigger` (GET + POST, zod `body`, `responseBody` variant via `greetJson`, `.meta({example})`), `cronTrigger` (schedule + explicit IANA tz) + callable-style invocation (`fireCron` http trigger calls `everyFiveMinutes()` directly), `manualTrigger` (zod `input` + `output`), `z` re-export, `secret()`, `sendMail()`. SDK identity internals (brand symbols, type guards, `ManifestSchema`) are intentionally NOT imported by demo.ts — they are not author-facing; rename protection lives in `packages/sdk/src/index.test.ts`.
- sandbox-stdlib: `fetch` (happy path + error path in `fetchSafe`), `crypto.subtle`, `crypto.randomUUID`, `setTimeout`, `URL` / `URLSearchParams`, `console`, `performance.mark/measure` (`measure`), `EventTarget` + `CustomEvent` (`eventBus`), `AbortController`/`AbortSignal` (`cancellable`), `scheduler.postTask` (`scheduleTask`), `Observable` (`observeTicks`).
- Failure path: `fail` manualTrigger invokes the `boom` action which throws, so the dashboard renders a real `action.error` / `trigger.error` pair.

Every non-failure trigger dispatches the same `runDemo` orchestrator so any kind can exercise the full surface. A change that touches SDK surface or workflow-authoring ergonomics without updating `demo.ts` is incomplete.

Surface intentionally NOT exercised by demo.ts (would bloat the file without adding coverage beyond what package-level tests already provide): `CompressionStream`/`DecompressionStream`, `indexedDB`, `structuredClone`, `FormData`, `Blob`/`File`, raw `ReadableStream`/`WritableStream`/`TransformStream`, `TextEncoderStream`/`TextDecoderStream`, `URLPattern`, `queueMicrotask`, `reportError`, CLI binary (`wfe`, exercised by `pnpm upload` / `scripts/dev.ts`). If one of these ever needs a workflow-author regression guard, extend demo.ts at that point.

## Code Conventions

- All relative imports must use `.js` extensions (required by `verbatimModuleSyntax`; enforced by `pnpm check`)
- Use `z.exactOptional()` not `.optional()` for optional Zod fields (`exactOptionalPropertyTypes` is enabled; violations fail `pnpm check`)
- Factory functions over classes. Closures for private state.
- Named exports only. Separate `export type {}` from value exports. Exception: data-only modules whose filename already conveys identity (e.g. `skip.ts`) may use `export default`.
- `biome-ignore` comments must have a good reason suffix. Write code that doesn't need them. Remove any that lack justification.
- SDK surface or sandbox-stdlib changes must land with a matching update to `workflows/src/demo.ts` — see `## Example workflows`.
- PRs that change `packages/runtime/src/ui/static/workflow-engine.css` (or `trigger.css`) should keep `docs/ui-guidelines.md` in sync — token values, the green allowlist, kind/prefix icon tables, and component recipes are documented there. Behaviour contracts (theme detection, motion respect, CSP cleanliness, universal topbar, asset delivery) live in the `ui-foundation` and `ui-errors` OpenSpec capabilities — touching those requires a proposal.

### Formatter

Biome defaults (configured in `biome.jsonc`): tabs for indentation, 80-char line width, LF line endings, double quotes for JS/TS strings. `pnpm format` writes these in place; `pnpm lint` (aliased to `biome check --error-on-warnings .`) fails on formatter drift. Any rule disabled in `biome.jsonc` MUST carry an inline `//` comment explaining why — same convention as in-source `biome-ignore`.

## Security Invariants

Full threat model: `/SECURITY.md`. Consult it before writing security-sensitive code.

- **NEVER** add a Node.js surface, or a new guest-visible global, to the QuickJS sandbox without extending §2's "Globals surface" list in the same PR, with a threat assessment (§2).
- **NEVER** add a `GuestFunctionDescription` with `public: true` without a written rationale — descriptors default to `public: false` so phase-3 auto-deletes them from `globalThis` after plugin source eval (§2 R-1).
- **NEVER** install a top-level host-callable global for guest use without locking it via `Object.defineProperty({writable: false, configurable: false})` wrapping a frozen inner object; canonical examples are `__sdk` and `__mail` (§2 R-2).
- **NEVER** override `createFetchPlugin`'s default `hardenedFetch` in production composition; overriding is a test-only path via `__pluginLoaderOverride` (§2 R-3).
- **NEVER** add a plugin with long-lived state (timers, pending `Callable`s, in-flight fetches) without an `onRunFinished` that routes cleanup through the same path as guest-initiated teardown so audit events fire (§2 R-4).
- **NEVER** write plugin or workflow-author code that relies on guest-visible state (`globalThis` writes, module-level `let`/`const` mutations, closures over mutable module state) persisting between `sb.run()` calls. Every run observes a freshly-restored post-init snapshot; persistence of guest state is explicitly NOT a guarantee (§2 R-10). Host-side plugin state on `PluginSetup` (timers Map, compiled validators, etc.) continues to persist and is governed by R-4.
- **NEVER** mutate `bridge.*` or construct `seq`/`ref`/`ts`/`at`/`id` directly from plugin code — all events flow through `ctx.emit` / `ctx.request`, which stamp those fields internally (§2 R-5).
- **NEVER** introduce cross-thread method calls between main and worker; plugin code is worker-only and plugin configs MUST be JSON-serializable (verified by `assertSerializableConfig`) (§2 R-6).
- **NEVER** use the reserved event prefixes `trigger`, `action`, or `system` for third-party plugins; use a domain-specific prefix instead. Host-call kinds previously under `fetch.*`, `mail.*`, `sql.*`, `timer.*`, `console.*`, `wasi.*`, and `uncaught-error` were consolidated into `system.*` per the `bridge-main-sequencing` change, with the operation identity carried in the event's `name` field (e.g. `system.request name="fetch"`, `system.call name="setTimeout"`, `system.exception name="TypeError"`) (§2 R-7).
- **NEVER** stamp fields that belong to another layer of the stamping pipeline. The split is:
  - **Bridge-stamped (worker-side):** `kind`, `name`, `ts`, `at`, `input?`, `output?`, `error?`, the wire `type` framing discriminator, and (for opens) the worker-minted `callId`.
  - **Sandbox-stamped (main-side, by `RunSequencer`):** `seq` (per-run monotonic from 0), `ref` (parent-frame seq).
  - **Runtime-stamped (executor's `sb.onEvent` widener):** `id`, `owner`, `repo`, `workflow`, `workflowSha`, `invocationId`, and (on `trigger.request` only) `meta.dispatch`.
  Plugins MUST NOT touch `seq`/`ref`/`callId`. The worker MUST NOT parse `kind` for framing — the typed `type` field is the discriminator. `BusConsumer.handle` always sees a fully-widened `InvocationEvent`; consumers MUST NOT re-stamp or mutate any layer (§2 R-8).
- **NEVER** emit, read, or construct `InvocationEvent.meta` (including `meta.dispatch`) from inside sandbox or plugin code — `meta` is stamped only by the executor's `sb.onEvent` widener, gated on `event.kind === "trigger.request"`. Dispatch provenance (`{source, user?}`) is a runtime-only concern; guests never see it (§2 R-9; canonical contract in `openspec/specs/invocations/spec.md` under "Dispatch provenance on trigger.request").
- **NEVER** add authentication to `/webhooks/*` — public ingress is intentional (§3).
- **NEVER** add an authenticated UI route (`/dashboard`, `/trigger`, or any future authenticated UI prefix) without wiring `sessionMiddleware` into its middleware factory (§4).
- **NEVER** add an `/api/*` route without the `apiAuthMiddleware` in front of it (§4).
- **NEVER** accept a `<owner>` URL parameter without validating against the owner regex (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`) AND the `isMember(user, owner)` predicate; when the route also carries a `<repo>` segment, the repo regex (`^[a-zA-Z0-9._-]{1,100}$`) MUST also validate. Both paths must fail-closed with a `404 Not Found` identical to "owner does not exist" to prevent enumeration (§4).
- **NEVER** expose workflow or invocation data cross-(owner, repo) in API responses, dashboard queries, or trigger listings — every query must be scoped by an `(owner, repo)` allow-list. For invocation events, the only scoped read API is `EventStore.query(scopes)` and every call site MUST route through `resolveQueryScopes(user, registry, constraint?)` (never construct a raw `Scope` from URL input); for workflows, route through `WorkflowRegistry`, which is keyed by `(owner, repo)` (§1 I-T2, §4).
- **NEVER** read `X-Auth-Request-*` on any code path. Forward-auth identity was removed by the `replace-oauth2-proxy` change; no upstream produces those headers any more. Neither `apiAuthMiddleware` (API) nor `sessionMiddleware` (UI) reads them, and reading them anywhere would reintroduce the forged-header class (§4 A13).
- **NEVER** weaken the app-pod `NetworkPolicy` (§5 R-I1). The load-bearing controls against the forged-header class are now app-side (no code path reads `X-Auth-Request-*`) and edge-side (oauth2-proxy sidecar removed, no upstream produces those headers) per §4 A13; the NetworkPolicy remains as defence-in-depth and as a baseline for blast radius on any future in-cluster compromise.
- **NEVER** hardcode or commit a secret; route all *secret* values (credentials, keys, tokens) through K8s Secrets injected via `envFrom.secretRef` (§5). Non-secret config (`AUTH_ALLOW`, `LOG_LEVEL`, `PORT`, `BASE_URL`, `LOCAL_DEPLOYMENT`, `PERSISTENCE_S3_BUCKET`, etc.) is intentionally visible in pod specs for auditability and does NOT require `envFrom.secretRef` — see `openspec/specs/runtime-config/spec.md` "AUTH_ALLOW config variable" for the canonical auditability carve-out.
- **NEVER** log, emit, or store the `Authorization` header, session cookies, or OAuth secrets (§4).
- **NEVER** add a config field sourced from a K8s Secret without composing its Zod schema with `.transform(createSecret)` so the field's value on the returned config object is a `Secret`-wrapped type that self-redacts on `JSON.stringify` / `String()` / `util.inspect` (§5; canonical examples: `GITHUB_OAUTH_CLIENT_SECRET`, `PERSISTENCE_S3_ACCESS_KEY_ID`, `PERSISTENCE_S3_SECRET_ACCESS_KEY` in `packages/runtime/src/config.ts`).
- **NEVER** add a K8s workload with `automountServiceAccountToken` enabled unless it has a dedicated `ServiceAccount` with scoped RBAC and a documented justification in `SECURITY.md` §5 / I11.
- **NEVER** add `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `'strict-dynamic'`, or a remote origin to the CSP in `secure-headers.ts` (§6). The local-only `frame-ancestors 'self' vscode-webview:` carve-out gated by `LOCAL_DEPLOYMENT=1` (which also drops `X-Frame-Options`) is the sole exception; production keeps `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
- **NEVER** add an inline `<script>`, inline `<style>`, `on*=` event-handler attribute, `style=` attribute, string-form Alpine `:style` binding, or free-form `x-data` object literal to any HTML served by the runtime. All behaviour goes to `/static/*.js` and is bound via `addEventListener` over `data-*` hooks; if Alpine is genuinely needed, components MUST be pre-registered via `Alpine.data(...)` in a `/static/*.js` module (§6).
- **NEVER** remove the `LOCAL_DEPLOYMENT=1` HSTS gate; pinning HSTS on `localhost` breaks every other local dev service for up to a year (§6).
