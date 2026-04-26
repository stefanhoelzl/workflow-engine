## Context

The workflow engine currently has two test layers: per-package unit tests (sandbox boundary, SDK brands, plugin composition, registry semantics, etc.) and one in-process integration file (`packages/runtime/src/integration.test.ts`, ~1150 lines, hand-crafted IIFE bundles wired through the runtime composition root in-memory). Both layers run as part of `pnpm test` / `pnpm validate`.

Neither layer can observe several invariants that only manifest end-to-end: real `process.exit` semantics, signal handling (SIGTERM drain vs SIGKILL crash), the disk-flush window between `pending/<id>.json` write and process death, real HTTP routing for `(owner, repo)`-scoped URLs, real Postgres TLS handshake + server-side `statement_timeout`, real SMTP socket transport, the dashboard / trigger UI / login flow under a real browser, sandbox-store eviction under count pressure (the `sandbox evicted` log line), and the sealed-bundle round-trip via the real `/api/public-key` endpoint.

The framework introduced here is a third test layer that spawns the runtime as a real Node.js subprocess against shared in-process mocks (Postgres, HTTP echo, SMTP) and a Playwright browser. It is the first time the project has a test surface that exercises the assembled binary as a black box.

A 12-decision conversation has already settled the framework's shape (boot model, fixture strategy, mock infrastructure, parallelism layers, log scoping, DSL surface, phasing). This document captures the design as decided so PR-by-PR implementation can proceed without revisiting each choice.

## Goals / Non-Goals

**Goals:**
- Cover 19 end-to-end-only invariants, one per test, that the unit and in-process integration layers cannot reach.
- Provide a single declarative chain DSL — `s.workflow(...).webhook(...).expect(...)` — that reads top-to-bottom as a list of asserted facts. No imperative escape hatch: every test fits this form, or the DSL grows to accommodate it.
- Freeze the public test-author surface up front. PR-by-PR implementation grows the framework additively; no PR refactors what an earlier PR shipped.
- Run as a separate CI job (`pnpm test:e2e`), not in `pnpm validate`. Suite wall-clock target: <30 s on an 8-core machine.
- Reuse the project's real upload pipeline (`upload()` from `@workflow-engine/sdk/cli`) and real build pipeline (`build()` from the same package) — no shadow code paths.
- Decouple the framework from runtime internals. Event observation is filesystem-polled (persistence dir), not log-line-coupled (consumer ordering). One log-line dependency remains: `shutdown.complete`, intentionally added to the runtime as an operationally-useful drain audit signal.

**Non-Goals:**
- Replacing `runtime/integration.test.ts` or per-package unit tests. Those keep all happy-path coverage; E2E covers only what they can't reach. Opportunistic migration is allowed; mass migration is not a goal.
- Cluster / Traefik / cert-manager / NetworkPolicy testing. That stays in the `pnpm local:up:build` smoke runbook for human operators.
- Surface coverage parity with unit tests. The 19-test budget is intentional; padding it with happy-path repeats is explicitly out of scope.
- Test framework parity with industry-standard E2E frameworks (Playwright Test, Cypress). The framework is purpose-built for one product.
- Watch mode in v1. If a developer iterates on SDK while running E2E repeatedly, they can wire `pnpm build:watch` and `vitest --watch` themselves; no first-class support.

## Decisions

### Boot model: pure spawn, one child per `describe`

Each `describe` block boots one `node packages/runtime/dist/main.js` subprocess against a tmp persistence dir. The framework communicates with the child via:
- HTTP requests for `.fetch`, `.webhook`, `.manual` (the runtime's own surface)
- stdout pino-line tail for `LogStream` (`shutdown.complete`, `sandbox evicted`, `http.listening`)
- filesystem reads for invocation events (the runtime's persistence dir is the source of truth)
- POSIX signals for `.sigterm`, `.sigkill`

**Why pure spawn over in-process composition** (alternative considered): in-process is faster (~100 ms vs ~500 ms boot) and gives direct access to `eventStore` / `registry` / `sandboxStore`, but it loses real signal semantics, real `process.exit`, real fake-timer immunity (every test is real wall-clock anyway), and faithful binary execution. The faithfulness gap with `start()` (which only adds signal handlers + a fatal-error logger) is small enough that we don't run a parallel in-process layer.

**Why one child per `describe`** (alternatives considered: one per file, one per test, one shared with reset endpoint): per-test is too expensive (~5 min just for spawns over 200 tests). Shared-with-reset requires shipping a `POST /__test/reset` route in production code — security risk and surface-area cost. Per-`describe` balances spawn cost (~1 s) against test isolation; non-destructive tests within a describe share the child via `test.concurrent`.

### Test-author surface: `{describe, test, expect}`, frozen up front

Three exports. One `test(name, s => s.chain())` form. No `test.raw`, no `test.browser`, no escape-to-vitest. If a future test doesn't fit the chain, the right response is to extend the chain DSL or reconsider whether the invariant belongs at this layer.

This forces the framework to stay coherent. Adding a primitive becomes a deliberate decision tied to a concrete test; tests cannot silently bypass the DSL.

The chain DSL has nine methods, with `ScenarioState` carrying typed accumulators for every repeatable step. Full surface frozen below under §"Frozen surface".

### Inline workflow fixtures via plain template-literal source strings

```ts
.workflow("name", `
  import {defineWorkflow, httpTrigger, z} from '@workflow-engine/sdk';
  defineWorkflow();
  export const ping = httpTrigger({...});
`)
```

The string is a complete TypeScript module. Framework writes to a temp `.ts`, runs `build()` from `@workflow-engine/sdk/cli` (the same `build()` that `wfe upload` uses internally), caches the resulting bundle.

**Why plain strings over alternatives** (`fn.toString()`-extracted closures, sibling `.ts` files, `?raw` imports, `/* ts */` tagged templates): we audited each. `fn.toString()` requires ~300 lines of AST extraction code with subtle edge cases (closures, nested braces, post-TS-strip source artifacts). Sibling files split fixture and test across two buffers, hurting at the ~10-line median fixture size we have. `?raw` imports + tagged templates buy editor highlighting via VS Code extensions but no real type smarts. Plain strings cost zero framework code and lose only editor support inside the string — at 10-line median fixtures that's tolerable.

### Fixture build cache with `.build-hash` sentinel

Layout:

```
node_modules/.cache/wfe-tests/
  .build-hash               ← sha256(packages/sdk/dist + packages/core/dist)
  <fixture-key>/<artifacts> ← per-fixture: sha256([source, name, owner, repo])
  ...
```

At `globalSetup`: compute the SDK+core dist hash, compare to `.build-hash`. If absent or different → wipe `wfe-tests/*`, write new sentinel. After this point all surviving entries are guaranteed to match the current SDK/core; per-fixture lookups don't re-check.

**Why sentinel-wipe over alternatives** (LRU eviction, time-based eviction, no eviction): SDK/core changes invalidate every cache entry simultaneously; LRU and time-based approaches keep stale entries around uselessly. Sentinel-wipe matches the actual invalidation semantics. Concurrent test runs on the same machine with different SDK builds can race, but the worst case is a cache miss + rebuild; never corruption (atomic `mkdtemp` + `rename` per fixture).

### Mock infrastructure: `createMockServer(mock: Mock<TCapture, TConn>)` factory

Each mock implements a small interface:

```ts
interface Mock<TCapture extends MockCapture, TConn> {
  readonly name: string;
  start(record: (capture: TCapture) => void): Promise<TConn>;
  stop(): Promise<void>;
}
```

`createMockServer` wires a uniform admin HTTP server around any `Mock` implementation. Admin protocol:

```
GET  /captures?slug=<slug>&since=<ts>   → 200 application/json [TCapture]
GET  /stream?slug=<slug>                 → 200 text/event-stream (replays backlog, then live-streams)
POST /reset?slug=<slug>                  → 204
```

Tests consume mocks via a single `MockClient<TCapture>` class (three methods: `captures`, `waitFor`, `reset`). All three mocks (embedded-postgres, HTTP echo, SMTP catcher) share this protocol and client.

**Why composition over inheritance**: matches the project's "factory functions over classes; closures for private state" convention (CLAUDE.md §Code Conventions). Each mock subclass shrinks to ~30-50 lines focused on what makes it different (how it accepts traffic, how it derives the slug from the request).

### Cross-worker mock sharing via vitest `provide`/`inject`

`globalSetup` boots all three mocks once per suite run, exposes their `{adminUrl, connection}` tuples via `provide("mocks", {...})`. Workers `inject("mocks")` to connect. No tmp-file manifest, no env vars; vitest's `structuredClone` over its worker RPC channel handles the serialization.

Per-test correlation across cross-worker shared mocks via the test's slug:
- HTTP captures filtered by URL path embedding the slug (`/<slug>/...`)
- SMTP captures filtered by recipient plus-addressing (`dest+<slug>@test`)
- SQL: shared default DB (no per-test DB lifecycle in v1; the two SQL tests in scope are stateless reads)

Slug shape: `<file-basename>-<describe>-<test>`, slugified, with hash-suffix only as overflow handling for the 63-char owner regex.

### Event observation: filesystem polling, not log-line subscription

`state.events` and `.waitForEvent({label?, kind?, archived?, trigger?, owner?, repo?})` poll the spawned child's persistence directory:
- `archived: false` (or unspecified, in-flight) → poll `<persistencePath>/pending/*.json`
- `archived: true` → poll `<persistencePath>/archive/*.json`

Poll cadence ~25 ms; per-`waitForEvent` hard cap default 5 s.

**Why FS polling over log-line subscription** (alternative considered): log-line subscription couples the framework to runtime consumer ordering (persistence consumer must run before logging consumer; otherwise the `invocation.started` log line precedes the durable pending file). FS polling is the source of truth and decouples cleanly. The cost (one poll loop) is bounded — only `.waitForEvent` polls; everything else uses pure subscription (LogStream tails stdout; mock clients use SSE).

### Log observation: stdout pino tail, auto-scoped per test

`LogStream` tails the child's stdout, parses each line as pino JSON, buffers in memory. Three operations:
- `query(predicate)` — synchronous filter on buffered lines
- `waitFor(predicate, opts)` — subscription with replay-on-call, hard cap as safety net
- `assertNotPresent(value)` — strict assertion that the value never appears in stdout/stderr (used by sealed-secret + sendMail-redaction tests)

Auto-scoping per test: `LogStream` exposes `mark()` / `since(mark)`; framework's `beforeEach` auto-marks at test start. `query` and `assertNotPresent` default to scanning since the mark, so tests running `test.concurrent` against a shared child don't see each other's log lines.

### Log-line dependencies on the runtime

Two log lines are load-bearing for tests:
- `http.listening port=N` — already emitted; framework reads it to know when the child is ready (after `app.start()`).
- `shutdown.complete` — **NEW**: emitted by `runtimeLogger.info("shutdown.complete", {code, durationMs})` at the end of the runtime's shutdown handler, before `process.exit(code)`. The SIGTERM-drain test subscribes to it as the "graceful shutdown finished" signal.

The `shutdown.complete` line is also operationally useful (drain audit trail in production) and is the only runtime change in this proposal. Spec delta lands in `service-lifecycle/spec.md`.

**No `invocation.started` ordering dependency**: an earlier draft proposed documenting that consumer ordering (persistence → logging) is load-bearing for crash-recovery. We chose FS polling instead, which removes the dependency entirely.

### Parallelism: three nested layers

1. **`globalSetup`** boots three mock services (~2 s once, amortized).
2. **Vitest worker pool** (default = one per CPU) runs files in parallel. Each worker reads mock addresses via `inject`, spawns its own runtime children, launches one chromium browser (reused across UI tests in the worker, fresh `BrowserContext` per test).
3. **Per-`describe`** spawns one runtime child. Non-destructive tests (15 of 19) run via `test.concurrent` against a shared per-describe child; destructive tests (4 of 19: SIGKILL, SIGTERM, LRU with custom env, sealed-secret with log scoping ambiguity) get their own describes with sequential execution.

**Suite wall-clock target**: ~12-15 s with 8 workers × 8 files distributed evenly. Inside the 30 s budget with margin.

### Phasing: 17 PRs, one test per PR

Each PR adds the minimum framework increment needed for one new test (PR 17 lands tests #10 and #11 together because they reuse the same primitives; PR 15 lands tests #12 and #13 together because they share the pg mock setup). PR 1 is irreducibly the largest (~350 lines framework + 1 test) because the framework MVP cannot be smaller and still execute one scenario. PRs 2-17 are additive only — types are frozen by this design so no PR refactors what an earlier PR shipped.

PR sequence:

```
PR 1   Framework MVP                            + test #14 (plain env round-trip)
PR 2   .webhook body/headers/query              + test #15 (httpTrigger protocol)
PR 3   .waitForEvent (FS polling)               + test #16 (cronTrigger fires)
PR 4   multi-workflow + explicit .upload()      + test #6  (multi-backend)
PR 5   owner/repo opts                          + test #19 (org/repo scoping)
PR 6   labels + LogStream waitFor/query         + test #5  (re-upload + eviction)
PR 7   describe env opt                         + test #7  (LRU eviction)
PR 8   log-scoping (mark/since) + assertNotPresent + test #1 (sealed secret)
PR 9   .sigkill {restart} + respawn             + test #2  (crash recovery)
PR 10  .sigterm {restart} + shutdown.complete   + test #3  (SIGTERM drain)
PR 11  .fetch                                    + test #4  (health endpoint)
PR 12  .fetch auth resolution                    + test #8  (cross-owner 404)
PR 13  mock infrastructure + http-echo mock     + test #17 (fetch SSRF guard)
PR 14  smtp mock                                 + test #18 (sendMail + redaction)
PR 15  pg mock with TLS                          + tests #12 + #13 (SQL TLS + timeout)
PR 16  Playwright + .browser + login helper     + test #9  (login + signout)
PR 17  (uses existing primitives)                + tests #10 + #11 (dashboard + trigger UI)
```

Plus one optional perf PR (fixture build cache with `.build-hash` sentinel) slotted around PR 5-6 when rebuild times start hurting; pure optimization, no behavioural change.

## Frozen surface (load-bearing for PR sequencing)

The following types and methods are the public contract. PR 1 ships the **types** for all of them; only the methods needed for test #14 are implemented. PRs 2-17 implement the rest. No PR may change a signature shipped by an earlier PR.

```ts
// public exports
export {describe, test, expect};

// describe — wraps vitest describe, spawns one child per block
function describe(name: string, body: (app: AppHandle) => void): void;
function describe(name: string, opts: {env?: Record<string, string>}, body: (app: AppHandle) => void): void;

// test — wraps vitest test, body returns the chain, framework runs it
function test(name: string, body: (s: Scenario) => Scenario): void;

interface AppHandle {
  readonly baseUrl: string;
}

interface Scenario {
  workflow(name: string, source: string, opts?: WorkflowOpts): this;
  upload(opts?: {label?: string}): this;
  fetch(path: string, opts?: FetchOpts): this;
  webhook(triggerName: string, opts?: WebhookOpts): this;
  manual(triggerName: string, input?: unknown, opts?: ManualOpts): this;
  waitForEvent(filter: EventFilter, opts?: {hardCap?: number}): this;
  expect(callback: (state: ScenarioState) => void | Promise<void>, opts?: {hardCap?: number}): this;
  sigterm(opts?: SignalOpts): this;
  sigkill(opts?: SignalOpts): this;
  browser(callback: (ctx: BrowserContext) => Promise<void>): this;
}

interface WorkflowOpts { owner?: string; repo?: string; label?: string; }
interface FetchOpts extends RequestInit {
  auth?: {user: string; via: "cookie" | "api-header"};
  as?: "json" | "text" | "response";
  label?: string;
}
interface WebhookOpts {
  body?: unknown; headers?: HeadersInit; query?: Record<string, string>;
  owner?: string; repo?: string; label?: string;
}
interface ManualOpts { user?: string; owner?: string; repo?: string; label?: string; }
interface EventFilter {
  label?: string;
  kind?: "trigger.request" | "trigger.response" | "trigger.error";
  archived?: boolean;
  trigger?: string;
  owner?: string; repo?: string;
}
interface SignalOpts { restart?: boolean; }
interface BrowserContext {
  page: import("playwright").Page;
  state: ScenarioState;
  login: (user: string) => Promise<void>;
}

interface ScenarioState {
  workflows: CapturedSeq<WorkflowRef>;
  uploads:   CapturedSeq<UploadEntry>;
  responses: CapturedSeq<HttpResponse | {error: string}>;
  fetches:   CapturedSeq<FetchResult>;
  events:    readonly InvocationEvent[];   // FS-polled
  archives:  CapturedSeq<InvocationArchive>;
  logs:      readonly LogLine[];           // stdout pino, auto-scoped to test start
  http: MockClient<HttpCapture>;
  smtp: MockClient<MailCapture>;
  sql:  MockClient<SqlCapture>;
}

interface WorkflowRef { name: string; sha: string; owner: string; repo: string; }
interface UploadEntry { owner: string; repo: string; workflows: readonly {name: string; sha: string}[]; }
interface HttpResponse { status: number; headers: Headers; body: unknown; }
interface FetchResult extends HttpResponse {}

type CapturedSeq<T> = readonly T[] & {
  byIndex(i: number): T;
  byLabel(name: string): T;
};

interface MockCapture { ts: number; slug?: string; }
interface MockClient<TCapture extends MockCapture> {
  captures(opts?: {slug?: string; since?: number}): Promise<readonly TCapture[]>;
  waitFor(predicate: (c: TCapture) => boolean, opts?: {slug?: string; hardCap?: number}): Promise<TCapture>;
  reset(slug?: string): Promise<void>;
}
```

## Risks / Trade-offs

**Risk: Vitest worker model + suite-shared mocks doubles memory**
Mocks are shared cross-worker via `provide`/`inject`, but each worker still runs its own runtime children + chromium browser. 8 workers × ~150-300 MB worker = ~1.5-2.5 GB peak.
→ Mitigation: matches typical CI runner capacity; if local-dev memory becomes a problem, cap workers via vitest's `pool.threads.maxThreads`.

**Risk: Playwright in CI is inherently flakier than HTTP**
3 browser tests; chromium downloaded per CI run unless cached.
→ Mitigation: tests use `expect(...).toBeVisible()`-style waits, never `waitForTimeout`. Playwright cache (`~/.cache/ms-playwright`) reused across CI runs.

**Risk: embedded-postgres on Apple Silicon / arm**
Package bundles binaries per OS+arch; needs verification on target dev machines and CI.
→ Mitigation: check at PR 15 (when mock lands); fall back to a `postinstall`-driven download if bundled binaries are missing.

**Risk: real wall-clock cron test floor (~2 s)**
The cron test (#16) waits for an `* * * * * *` cron to fire — observed via FS polling, but bounded by the cron's actual fire cadence.
→ Mitigation: only one cron test in the inventory. If under loaded CI the cadence stretches, raise the hard cap from 5 s to 10 s for that one test.

**Risk: Slug collision across files with the same basename**
Two test files named `auth.test.ts` in different directories produce the same slug prefix.
→ Mitigation: hash-suffix overflow handling (already in design). Probability is low in this monorepo (we control fixture filenames); detectable via the per-test slug being unique within the cache.

**Risk: PR 1 is large (~350 lines + 1 test)**
The framework MVP is irreducible; you can't run a scenario test without spawn + fixture-build + chain runner + log tail.
→ Mitigation: every line in PR 1 is justified by the one test. Reviewer sees framework code paired with concrete usage — no speculative scaffolding. Subsequent PRs are small (one test + an additive primitive).

**Risk: `shutdown.complete` log line semantics**
The line MUST be emitted as the last act before `process.exit`, after `Promise.allSettled` of service stops. A future refactor could move it incorrectly.
→ Mitigation: spec'd in `service-lifecycle/spec.md` with a specific scenario; SIGTERM-drain test catches regressions.

**Trade-off: no escape hatch makes the framework rigid**
If a future invariant doesn't fit the chain DSL, we either extend the DSL (with PR overhead) or skip the test.
→ Acceptance: the rigidity is the point. The 19 tests we have all fit; growing the DSL one primitive at a time keeps the surface coherent.

**Trade-off: FS polling for events**
~25 ms cadence + 5 s hard cap per `waitForEvent`. Adds latency vs subscription.
→ Acceptance: polling cost is bounded (only `.waitForEvent`); decoupling from runtime consumer ordering is worth more than the latency.

## Migration Plan

1. PR 1 lands: framework MVP + test #14 + `pnpm test:e2e` script + new GitHub Actions job. The new job runs alongside `validate`; failure on `test:e2e` does not block merges initially (treated as advisory) for ~one week to surface CI flake.
2. After ~one week with green runs, the `test:e2e` job becomes a required check on the `main` branch.
3. PRs 2-17 land incrementally. Each is a small focused change; each adds one test to the suite. `test:e2e` stays green throughout (any PR that breaks it is rolled back).
4. PR 10 introduces the `shutdown.complete` log line — additive, no breaking change to the runtime. Spec delta lands in the same PR.
5. No rollback plan for the framework itself: it's a new package, it can be disabled by removing the `test:e2e` script from CI without touching anything else.

## Open Questions

- **Watch mode**: deferred to v2. If developers want auto-rebuild when iterating on SDK + E2E together, we add `pnpm test:e2e:watch` running `pnpm build:watch` and `vitest --watch` in parallel. Not v1.
- **embedded-postgres CI binary cache invalidation**: needs to verify the package's hash-keying matches our cache strategy. Resolved at PR 15.
- **Slug truncation collision diagnostic**: the framework should log a clear error if two tests slugify to the same value. Resolved at PR 8 (when the slug machinery becomes load-bearing for log-scoping).
- **Browser test parallelism**: we plan one chromium browser per worker, fresh `BrowserContext` per test. If chromium memory becomes a bottleneck under high worker count, revisit at PR 16.
