# Project Notes

## Tools

- Run `openspec` via: `pnpm exec openspec`
- Read `openspec/project.md` for architecture context

## Commands

- `pnpm lint` — Biome linter
- `pnpm check` — TypeScript type checking
- `pnpm test` — Vitest test suite (unit + integration, excludes WPT)
- `pnpm test:wpt` — WPT compliance suite (separate from `pnpm test`); `WPT_CONCURRENCY` overrides default (each file spawns its own sandbox worker, so keep it low)
- `pnpm test:wpt:refresh` — regenerate `packages/sandbox-stdlib/test/wpt/vendor/` from upstream WPT
- `pnpm build` — `pnpm -r build` across workspaces. Workflows emit per-file `workflows/dist/<name>.js`; the deployable tarball is built in-memory by `wfe upload` (seals secrets against the server pubkey)
- `pnpm start` — `pnpm build` then `pnpm dev`

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

**Pre-merge infra plan gate.** Changes under `infrastructure/envs/{cluster,persistence}/` (or modules they consume) MUST be applied locally by the operator before the PR can merge — agents surface this in their summary and do NOT run `tofu apply`. Full flow: `docs/infrastructure.md` "Pre-merge plan gate".

## Definition of Done

- `pnpm validate` must pass. Runs in parallel: `pnpm lint` (Biome), `pnpm check` (TypeScript), `pnpm test` (Vitest unit + integration; **excludes WPT** — run `pnpm test:wpt` separately when touching sandbox-stdlib), and `tofu fmt -check` + `tofu validate` for every infrastructure env.
- `pnpm test:e2e` — gated separately in CI; spawns a real runtime child per `describe`. Run locally before pushing when changes touch runtime spawn/shutdown, the SDK CLI upload pipeline, persistence layout, plugin host-calls, or authenticated UI routes. See `packages/tests/README.md`.

## Dev verification

Agents verify most changes against `pnpm dev` (http://localhost:<port>), not the full cluster. `pnpm dev` boots the runtime, auto-uploads `workflows/src/demo.ts` and `workflows/src/demo-advanced.ts` under owner `local` (repos `demo` and `demo-advanced`), and hot-reloads on source changes — no kind cluster, no Traefik, no cert-manager.

**Escalate to `pnpm local:up:build` (https://localhost:8443) only when the change touches:** `infrastructure/`, Traefik routing/middleware, `secure-headers.ts` (CSP/HSTS/Permissions-Policy), `NetworkPolicy`, cert-manager, K8s manifests, or Helm values. Agents do NOT run `pnpm local:up:build` themselves; they write a `Cluster smoke (human)` block in `tasks.md` listing the specific probes for a human to run. Local auth (`/login`, the local-user dropdown, session-cookie flows) is NOT a cluster-escalation reason — the in-app local provider renders identically under `pnpm dev`.

### Spawn & readiness

1. Start backgrounded: `pnpm dev --random-port --kill`. Agents use `run_in_background` so the process tree is owned by the agent.
2. Grep stdout for the ready marker: `Dev ready on http://localhost:<port> (tenant=dev)`. Parse the port from that line — the literal `tenant=dev` is a stale legacy string emitted by `scripts/dev.ts:353`; the actual upload target is owner `local`, not `dev`. Do NOT probe before the marker appears — the port opens before the initial `runUpload` completes, so early curl will hit an empty registry.
3. Kill the process tree at end of task. `.persistence/` is left as-is between tasks; each boot re-uploads the bundle anyway.

### Auth fixture

`scripts/dev.ts` sets `AUTH_ALLOW=local:local,local:alice:acme,local:bob` and `LOCAL_DEPLOYMENT=1`. Gotchas:

- `/api/*`: `X-Auth-Provider: local` + `Authorization: User <name>`. The only API routes are `POST /api/workflows/<owner>/<repo>` and `GET /api/workflows/<owner>/public-key` — there is no `GET /api/workflows/<owner>` listing; scrape `/dashboard/<owner>` instead.
- `/webhooks/*` is public.
- UI routes: `POST /auth/local/signin` form field is `user=` (NOT `name=` — handler reads `body.user`); reuse the sealed `session` cookie. For Alpine interactivity, use Playwright.

### Canonical fixture

`workflows/src/demo.ts` is the probe target. Its triggers: `runDemo` cron, http GET + POST under `/webhooks/local/demo/*`, manual `fail` (exercises the `action.error` / `trigger.error` path). SDK or sandbox-stdlib changes must keep `demo.ts` in sync (see `## Example workflows`), so the probe surface stays stable.

### Probe toolkit

- **HTTP**: `curl` against `POST /webhooks/local/demo/<trigger>` (public webhooks), `/dashboard/local/demo` (session cookie), `/trigger/local/demo` (session cookie). Assert on status code + JSON/HTML content. To list workflows or trigger names, scrape the dashboard HTML — there is no `GET /api/workflows/<owner>` JSON listing.
- **EventStore**: inspect `.persistence/` for emitted events (`invocation.started`, `invocation.completed`, `trigger.request`, `action.error`, …). Useful when verifying owner scoping or event-shape changes without a UI.
- **Dashboard HTML scraping**: grep rendered output for expected classes (`kind-trigger`, `kind-action`, `kind-rest`, `.entry.skeleton`) — cheap UI regression check without a browser.
- **Stdout tailing**: tee the dev process's stdout to a file; grep for error traces and upload confirmations.
- **Playwright** (agent-only; NOT in `pnpm test` / `pnpm validate`): use for Alpine-driven interactivity, focus rings, form submission, copy-event buttons. First-time use in a fresh clone requires `pnpm exec playwright install chromium` (~300 MB download, one-time). Scripts are ad-hoc via `pnpm exec playwright test -c <inline-config>` or `node -e '...'` — no test suite wiring.

### `tasks.md` pattern

When authoring an openspec change, write dev-probe bullets the agent ticks (curl + `.persistence/` checks against `pnpm dev`) instead of "visit https://localhost:8443 and click X". Add a `## Cluster smoke (human)` block only when the change touches edge/auth/infra. See an existing `openspec/changes/*/tasks.md` for the shape.

## Upgrade notes

See `docs/upgrades.md` for tenant rebuild/re-upload requirements per change.

## Example workflows

`workflows/src/demo.ts` is the canonical authoring reference. Keep it in sync with any SDK surface or sandbox-stdlib change. It showcases:

- SDK factories: `defineWorkflow({env})`, `env()`, `action` composition (action calls action), `httpTrigger` (GET + POST, zod `body`, `responseBody` variant via `greetJson`, `.meta({example})`), `cronTrigger` (schedule + explicit IANA tz) + callable-style invocation (`fireCron` http trigger calls `everyFiveMinutes()` directly), `manualTrigger` (zod `input` + `output`), `z` re-export, `secret()`, `sendMail()`. SDK identity internals (brand symbols, type guards, `ManifestSchema`) are intentionally NOT imported by demo.ts — they are not author-facing; rename protection lives in `packages/sdk/src/index.test.ts`.
- sandbox-stdlib: `fetch` (happy path + error path in `fetchSafe`), `crypto.subtle`, `crypto.randomUUID`, `setTimeout`, `URL` / `URLSearchParams`, `console`, `performance.mark/measure` (`measure`), `EventTarget` + `CustomEvent` (`eventBus`), `AbortController`/`AbortSignal` (`cancellable`), `scheduler.postTask` (`scheduleTask`), `Observable` (`observeTicks`).
- Failure path: `fail` manualTrigger invokes the `boom` action which throws, so the dashboard renders a real `action.error` / `trigger.error` pair.

Every non-failure trigger dispatches the same `runDemo` orchestrator so any kind can exercise the full surface. A change that touches SDK surface or workflow-authoring ergonomics without updating `demo.ts` is incomplete.

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

**Full threat model: `/SECURITY.md`.** Read it before any security-sensitive change — it owns the complete invariant list. Anchors agents trip on most often:

- `/webhooks/*` is public-by-design; `/api/*` requires `apiAuthMiddleware`; authenticated UI routes require `sessionMiddleware` (§3, §4).
- `<owner>` and `<repo>` URL params MUST validate against their regexes AND `isMember(user, owner)`, failing closed with 404 to prevent enumeration. Cross-(owner, repo) data leaks via `EventStore.query` or `WorkflowRegistry` are the highest-impact regression class (§4).
- Never read `X-Auth-Request-*` headers on any code path — forward-auth was removed; reading them reintroduces the forged-header class (§4 A13).
- Never add `'unsafe-inline'`/`'unsafe-eval'`/`'unsafe-hashes'`/`'strict-dynamic'`/remote origins to CSP, and never add inline `<script>`/`<style>`/`on*=`/`style=`/string-form `:style`/free-form `x-data` to runtime HTML — bind via `addEventListener` on `data-*` hooks; Alpine components register via `Alpine.data(...)` in `/static/*.js` (§6).
- New sandbox globals, `public: true` `GuestFunctionDescription`s, plugins with long-lived state, or new event prefixes need explicit treatment per `SECURITY.md` §2 — do not improvise.
- Secrets flow through K8s `envFrom.secretRef` and Zod `.transform(createSecret)`; never log `Authorization`, session cookies, or OAuth secrets (§4, §5).
