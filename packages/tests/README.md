# @workflow-engine/tests

End-to-end test framework. Spawns the assembled runtime as a real Node.js
subprocess and drives it through a frozen chain DSL. Covers invariants
the in-process integration tests can't reach: signal handling, sealed
secret round-trip, persistence-dir recovery, real SMTP/SQL/HTTP sockets,
browser flows.

## Running

```
pnpm test:e2e
```

`pnpm test:e2e` ≡ `pnpm build && vitest run --project tests`. It is
gated separately from `pnpm validate` in CI (its own GitHub Actions job)
and excluded from `pnpm test`.

## Test-author surface

The package exports exactly three values:

```ts
import { describe, expect, test } from "@workflow-engine/tests";
```

- `describe(name, [opts], body)` — wraps `vitest.describe`. Spawns one
  runtime child against a tmp persistence dir for the block. Tests
  inside share the child unless they take a destructive step
  (`.sigterm`, `.sigkill`). `opts` accepts `env` (per-describe runtime
  env) and `buildEnv` (per-describe env injected at fixture build time,
  e.g. to resolve `env({})` bindings).
- `test(name, scenarioFn)` — single form. The body returns a `Scenario`
  built from the `s` chain. The framework calls `.run()` implicitly.
- `expect` — re-exported from vitest unchanged.

That is the entire public surface. Type exports (`Scenario`,
`ScenarioState`, `CapturedSeq`, `MockClient`, …) are frozen by the
proposal and live in `src/types.ts`.

## The chain DSL

`s` is a lazy chain. Each method queues a step; the framework runs the
queue in order when the test wrapper resolves the returned `Scenario`.
The ten methods (frozen):

| Method | Purpose |
| --- | --- |
| `.workflow(name, source, opts?)` | Register an inline workflow source. Multiple calls per `(owner, repo)` queue together; flushed on next `.upload()` or implicitly before any fire step. |
| `.upload(opts?)` | Explicit flush of queued workflows. One upload per `(owner, repo)`. |
| `.fetch(path, opts?)` | Authenticated request against the runtime (`/api/*`, `/dashboard`, `/trigger`). Use `auth: {user, via: "cookie" \| "api-header"}`. |
| `.webhook(triggerName, opts?)` | Public `POST /webhooks/<owner>/<repo>/<trigger>`. Captures response into `state.responses`. |
| `.manual(triggerName, input?, opts?)` | Authenticated manual-trigger fire. |
| `.waitForEvent(filter, opts?)` | Polls the spawned child's `pending/*.json` and `archive/*.json` until a match. |
| `.expect(callback, opts?)` | Read `state` and assert. Retried until the callback stops throwing or `hardCap` elapses — `state` re-reads from disk on each retry. |
| `.sigterm(opts?)` / `.sigkill(opts?)` | Signal the child. With `restart: true` the framework respawns against the same persistence dir to exercise recovery. |
| `.browser(callback)` | Hand a Playwright `Page` (plus `state` and a `login(user)` helper) to the callback. Browser-per-worker, fresh context per test. |

`WorkflowOpts`, `WebhookOpts`, `ManualOpts`, `FetchOpts`, and
`EventFilter` all accept an optional `label` for byLabel lookup, and
`owner` / `repo` default to `(dev, e2e)`.

## State and CapturedSeq

`state.workflows`, `state.uploads`, `state.responses`, `state.fetches`,
and `state.archives` are `CapturedSeq<T>` — a readonly array plus
`byIndex(i)` and `byLabel(name)`. Pass a `label` on the originating step
to look the entry up by name later. `state.events` and `state.logs` are
plain readonly arrays.

`.expect` callbacks should read state without side effects: they retry
on assertion failure, re-reading from the persistence dir each time,
until the callback succeeds or `hardCap` (default 5 s) elapses.

## Mocks

The suite shares three out-of-process mocks across vitest workers via
`provide` / `inject`. Get the connection coordinates from
`@workflow-engine/tests/mocks`:

```ts
import { getMocks } from "@workflow-engine/tests/mocks";

const { echo, smtp, pg } = getMocks();
```

- `echo` — in-memory HTTP echo. Slug convention: the **first path
  segment** is the slug bucket. Use `echo.urlFor(slug, ...rest)` rather
  than hand-concatenating.
- `smtp` — in-memory SMTP catcher. Slug convention: a **plus-address on
  the recipient** (`dest+<slug>@test`). Use `smtp.recipient(slug)`.
- `pg` — embedded Postgres binary, optional TLS via `pg.ca`. Loopback
  by design; tests that need SQL must set
  `WFE_TEST_DISABLE_SSRF_PROTECTION=true` via `describe({env: …})`.

Inside `.expect`, observe captures via `state.http` / `state.smtp` /
`state.sql`, all of which are `MockClient<TCapture>` instances:

```ts
const captures = await state.http.captures({ slug: SLUG });
expect(captures).toHaveLength(0);
```

`MockClient` exposes `.captures({slug?, since?})`,
`.waitFor(predicate, {slug?, hardCap?})`, and `.reset(slug?)`. Always
pass `slug` so parallel tests don't read each other's traffic.

## Conventions

- **No escape hatch.** There is no `test.raw`, no direct child handle,
  no inline `await` between chain steps. If an invariant doesn't fit
  the chain, extend the chain DSL (frozen surface — needs a
  proposal-level decision) or reconsider the test. Don't reach around
  it.
- **Slug per test.** Pick a stable string (e.g. `const SLUG =
  "ssrf-loopback"`) and route every mock interaction through it. Mocks
  are suite-shared; the slug is the only isolation boundary.
- **`buildEnv` for env-bound workflows.** Workflows that use `env({})`
  resolve at fixture build time. Inject the value via
  `describe({buildEnv: {…}}, …)`, then read it inside the workflow as
  `workflow.env.FOO`. Don't bake the value into the source string.
- **Inline workflow source.** Fixtures are template-literal strings,
  not files. The framework writes them to a temp `.ts`, builds via
  `@workflow-engine/sdk/cli`, and caches the resulting bundle keyed by
  `sha256([sortedWorkflows, sortedBuildEnv])`. The cache lives at
  `packages/tests/.cache/wfe-tests/<key>/` and is invalidated by the
  `globalSetup` hash of `packages/sdk/dist` + `packages/core/dist`.

## Playwright

Tests that use `.browser(...)` launch chromium. On a fresh checkout,
install the binary once:

```
pnpm exec playwright install chromium
```

CI handles this automatically (`.github/workflows/ci.yml`, with
`~/.cache/ms-playwright` cached across runs).

## Where to look

- `src/types.ts` — frozen public type surface.
- `src/scenario.ts` — chain implementation.
- `src/describe.ts`, `src/spawn.ts` — runtime child lifecycle.
- `src/mocks/`, `src/mocks-api.ts` — mock servers and the suite-shared
  connection plumbing.
- `test/*.test.ts` — the 19 enumerated E2E tests; read these as the
  canonical examples of the chain DSL in use.
