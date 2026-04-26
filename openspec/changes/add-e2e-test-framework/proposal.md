## Why

The runtime ships unit tests per package and an in-process integration test (`packages/runtime/src/integration.test.ts`, ~1150 lines), but neither layer can observe end-to-end invariants that require the *real* spawned process: crash recovery via SIGKILL + respawn against the same persistence dir, graceful SIGTERM drain, sealed-secret round-trip (build-time seal → upload → runtime decrypt → handler reads plaintext + log redaction), cross-owner 404 enumeration semantics, sandbox-store eviction under count pressure, multi-backend reconfigure (one workflow registers http + cron in one upload), real Postgres TLS handshake + `statement_timeout` cancellation, fetch SSRF guard against a real loopback socket, sendMail through a real SMTP socket, and the dashboard / trigger UI / login flow. These invariants only manifest when the runtime binary boots, binds a real port, talks to real mocks, and persists to a real disk.

This change introduces an end-to-end test framework that drives the spawned runtime through a single, declarative chain DSL, with mocks shared across vitest workers and a frozen public surface that grows incrementally PR-by-PR.

## What Changes

- New top-level package `packages/tests/` (private, `@workflow-engine/tests`) housing the framework code, the mock implementations, and the 19 E2E tests that validate the invariants listed above.
- Public test-author surface frozen up front: exactly three exports — `describe`, `test`, `expect`. One `test(name, s => s.chain())` form. No `test.raw`, no escape hatch — if a future invariant doesn't fit the chain, the response is to extend the chain DSL or reconsider the test.
- Pure spawn boot model: each `describe` block spawns one runtime child against a tmp persistence dir and shared mocks; tests within a non-destructive describe run via `test.concurrent` against the shared child; destructive tests (kill, custom env) get their own describes.
- Scenario chain DSL with nine methods: `.workflow`, `.upload`, `.fetch`, `.webhook`, `.manual`, `.waitForEvent`, `.expect`, `.sigterm`, `.sigkill`, `.browser`. Lazy execution: methods queue steps; framework calls `.run()` implicitly via the `test` wrapper.
- Inline workflow fixtures as plain template-literal source strings (`s.workflow("name", \`...\`)`); framework writes to a temp `.ts`, calls `build()` from `@workflow-engine/sdk/cli`, caches the resulting bundle on disk under `node_modules/.cache/wfe-tests/<key>/` with a `.build-hash` sentinel that wipes the cache when SDK or core dist changes.
- Mock infrastructure built on a single composition factory: `createMockServer(mock: Mock<TCapture, TConn>)` wires an admin HTTP server (with `/captures`, `/stream` SSE, `/reset`) around any `Mock` implementation. Three implementations: embedded-postgres (with optional TLS), in-memory HTTP echo, in-memory SMTP catcher. Mocks are suite-shared across vitest workers via vitest's `provide`/`inject` (no tmp file).
- Event observation: `state.events` and `.waitForEvent` poll the spawned child's persistence dir (`pending/*.json`, `archive/*.json`); no log-line coupling to runtime consumer ordering. Log observation (`state.logs`, `assertNotPresent`) reads the child's stdout pino stream, auto-scoped per test via a `mark()` primitive.
- One runtime addition: `runtimeLogger.info("shutdown.complete", {code, durationMs})` emitted at the end of the runtime's shutdown handler, before `process.exit`. Used by the SIGTERM-drain test as the synchronization signal that graceful shutdown finished.
- New CI script `pnpm test:e2e` ≡ `pnpm build && vitest run --project tests`. Separate from `pnpm validate` and `pnpm test`; runs as its own GitHub Actions job.
- Implementation strategy: 17 PRs, each adding one test plus the minimum framework increment to enable it (PR 1 ships ~350 lines of framework MVP + the simplest test; PRs 2-17 add additive surface only — types are frozen by this proposal so no PR refactors what an earlier PR shipped).

## Capabilities

### New Capabilities
- `e2e-test-framework`: end-to-end test framework driving a spawned runtime through a chain DSL — covers framework scaffolding (package layout, vitest config, `pnpm test:e2e` script), spawn lifecycle (`describe` wrapper, child startup/shutdown, log stream, signal handling), inline-source fixture pipeline (build via `@workflow-engine/sdk/cli`, on-disk cache with `.build-hash` sentinel), the frozen scenario chain DSL surface (nine methods + `ScenarioState` shape + `CapturedSeq`), event sourcing via persistence-dir polling, mock infrastructure (`createMockServer`, `Mock<TCapture, TConn>` interface, `MockClient<TCapture>` SSE client, embedded-postgres / HTTP echo / SMTP catcher implementations, vitest `provide`/`inject` plumbing), Playwright integration (`.browser` chain step, browser-per-worker, fresh context per test, `login` helper), and the 19 enumerated E2E tests with their per-test invariants.

### Modified Capabilities
- `service-lifecycle`: adds the `shutdown.complete` structured log line to the runtime's shutdown handler. Operationally useful (drain audit trail in production); load-bearing for the SIGTERM-drain E2E test, which subscribes to it as the "graceful shutdown finished" signal.

## Impact

- **New code**: `packages/tests/` (framework + mocks + tests); estimated ~2-3k lines across all 17 PRs at completion. Initial PR ~350 lines framework + 1 test.
- **Modified code**: `packages/runtime/src/main.ts` shutdown handler — one new `runtimeLogger.info("shutdown.complete", {...})` line.
- **Dev dependencies added** (across phases): `embedded-postgres` (real Postgres binary, no Docker; ~30MB binary downloaded per OS at first install), `smtp-server` from nodemailer's repo (or hand-rolled minimal SMTP catcher, ~50 lines), `@playwright/test` plus chromium binary (downloaded via `pnpm exec playwright install chromium` in CI; ~300MB).
- **CI**: new GitHub Actions job for `pnpm test:e2e`, parallel with the existing `validate` job. Caches `~/.cache/embedded-postgres` and `~/.cache/ms-playwright` to avoid per-run binary downloads.
- **Existing tests**: `packages/runtime/src/integration.test.ts` and per-package unit tests are NOT replaced. E2E tests cover only invariants the in-process layer cannot reach; opportunistic migration is allowed but not required.
- **No breaking changes** to runtime, SDK, or workflow-author surface. The `shutdown.complete` log line is purely additive.
- **Documentation**: `packages/tests/README.md` documents the test-author surface (the three exports, the chain DSL, the no-escape-hatch rule); CLAUDE.md gets a brief pointer under the existing "Definition of Done" section noting that `pnpm test:e2e` exists and is CI-gated separately from `pnpm validate`.
