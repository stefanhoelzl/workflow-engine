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

The SDK ships a `wfe` binary (`packages/sdk/package.json` → `bin`). Invoke from the workflows project root via `pnpm exec`:

- `pnpm exec wfe upload --owner <name> --user <name>` — local-provider auth (server needs `LOCAL_DEPLOYMENT=1`); add `--url http://localhost:8080` to target local dev.
- `pnpm exec wfe upload --owner <name> --token <ghp_…>` — github-provider auth; `GITHUB_TOKEN` env var works too.

`--user`, `--token`, and `GITHUB_TOKEN` are mutually exclusive — see `SECURITY.md` §4 "CLI authentication".

## Infrastructure (OpenTofu + Scaleway VPS)

Prerequisites: OpenTofu >= 1.11.

Single flat tofu project at `infrastructure/`. Provisions one Scaleway VPS hosting Caddy + two app instances (prod + staging) as rootless Podman + Quadlet units. Local-disk persistence; no S3 in the running deployment. Tofu state lives on Scaleway Object Storage.

There is **no local cluster mode**. `pnpm dev` is the only local mode; agents verify against it. There is no kind, no podman-compose, no `pnpm local:up*`.

Prod/staging runbook: `docs/infrastructure.md`.

**Pre-merge infra plan gate.** A single `plan (vps)` job runs on every PR and fails the merge unless the plan is empty. Infra changes are operator-driven via the `apply-infra` `workflow_dispatch` workflow — agents do NOT run `tofu apply`; they surface the need to apply in the PR summary.

**Deploys.** No tofu in the deploy path. `deploy-staging` (push to `main`) and `deploy-prod` (push to `release`, gated by `environment: production`) only build + push the image to ghcr.io. The VPS's `podman-auto-update.timer` (1-min interval) pulls the new tag and restarts the unit. CI polls `/readyz` until `version.gitSha === <pushed sha>` to confirm the rotation before running `wfe upload` (staging only).

## Definition of Done

- `pnpm validate` must pass. Runs in parallel: `pnpm lint` (Biome), `pnpm check` (TypeScript), `pnpm test` (Vitest unit + integration; **excludes WPT** — run `pnpm test:wpt` separately when touching sandbox-stdlib), and `tofu fmt -check -recursive infrastructure/` + `tofu -chdir=infrastructure validate`.
- `pnpm test:e2e` — gated separately in CI; spawns a real runtime child per `describe`. Run locally before pushing when changes touch runtime spawn/shutdown, the SDK CLI upload pipeline, persistence layout, plugin host-calls, or authenticated UI routes. See `packages/tests/README.md`.

## Dev verification

Agents verify changes against `pnpm dev` (http://localhost:<port>). `pnpm dev` boots the runtime, auto-uploads `workflows/src/demo.ts` and `workflows/src/demo-advanced.ts` under owner `local` (repos `demo` and `demo-advanced`), and hot-reloads on source changes.

For changes touching `infrastructure/`, Caddyfile/routing, `secure-headers.ts` (CSP/HSTS/Permissions-Policy), or sshd/firewall posture, agents document the verification under `## Cluster smoke (human)` in `tasks.md`. Agents do NOT run `tofu apply`; the operator runs the `apply-infra` workflow.

### Spawn & readiness

1. Start backgrounded: `pnpm dev --random-port --kill`. Agents use `run_in_background` so the process tree is owned by the agent.
2. Grep stdout for the ready marker: `Dev ready on http://localhost:<port> (tenant=dev)`. Parse the port from that line. Do NOT probe before the marker appears — the port opens before the initial `runUpload` completes, so early curl will hit an empty registry.
3. Kill the process tree at end of task. `.persistence/` is left as-is between tasks; each boot re-uploads the bundle anyway.

Probe recipes (curl, EventStore, dashboard scrape, Playwright, auth fixture, canonical `demo.ts` triggers) live in `docs/dev-probes.md`.

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
- Biome defaults (`biome.jsonc`): tabs, 80-char width, LF, double quotes. `pnpm format` writes; `pnpm lint` fails on drift. Any rule disabled in `biome.jsonc` MUST carry an inline `//` reason — same convention as in-source `biome-ignore`.

## Security Invariants

**Full threat model: `/SECURITY.md`.** Read it before any security-sensitive change — it owns the complete invariant list. Anchors agents trip on most often:

- `/webhooks/*` is public-by-design; `/api/*` requires `apiAuthMiddleware`; authenticated UI routes require `sessionMiddleware` (§3, §4).
- `<owner>` and `<repo>` URL params MUST validate against their regexes AND `isMember(user, owner)`, failing closed with 404 to prevent enumeration. Cross-(owner, repo) data leaks via `EventStore.query` or `WorkflowRegistry` are the highest-impact regression class (§4).
- Never read `X-Auth-Request-*` headers on any code path — forward-auth was removed; reading them reintroduces the forged-header class (§4 A13).
- Never add `'unsafe-inline'`/`'unsafe-eval'`/`'unsafe-hashes'`/`'strict-dynamic'`/remote origins to CSP, and never add inline `<script>`/`<style>`/`on*=`/`style=`/string-form `:style`/free-form `x-data` to runtime HTML — bind via `addEventListener` on `data-*` hooks; Alpine components register via `Alpine.data(...)` in `/static/*.js` (§6).
- New sandbox globals, `public: true` `GuestFunctionDescription`s, plugins with long-lived state, or new event prefixes need explicit treatment per `SECURITY.md` §2 — do not improvise.
- Secrets flow through K8s `envFrom.secretRef` and Zod `.transform(createSecret)`; never log `Authorization`, session cookies, or OAuth secrets (§4, §5).
