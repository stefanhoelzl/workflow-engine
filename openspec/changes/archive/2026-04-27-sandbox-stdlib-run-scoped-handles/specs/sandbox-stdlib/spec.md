## ADDED Requirements

### Requirement: run-scoped handle helper

The sandbox-stdlib package SHALL provide an internal helper `createRunScopedHandles<T>(close: (h: T) => Promise<void> | void)` at `packages/sandbox-stdlib/src/internal/run-scoped-handles.ts`. The helper SHALL NOT be exported from the package index.

The helper SHALL return an object exposing:

- `track(handle: T): T` — record `handle` in an internal Set and return `handle` (for inline use). Idempotent (re-tracking the same handle is a no-op).
- `release(handle: T): Promise<void>` — remove `handle` from the Set, then await `close(handle)`. Errors thrown by `close` SHALL be swallowed. Calling `release` on an unknown or already-released handle SHALL be a no-op.
- `drain(): Promise<void>` — atomically snapshot the current Set, clear it, and call `close` on every handle. Closer invocations SHALL be awaited via `Promise.allSettled` so a single slow or throwing closer cannot block the others. Errors thrown by `close` SHALL be swallowed.

Plugin authors who allocate per-call host resources MUST track them via this helper and MUST register `onRunFinished: handles.drain` on their `PluginSetup` so that resources are released at run end if the per-call `release` was missed (e.g., the guest fired-and-forgot the host call).

#### Scenario: Helper drains tracked handles at run end

- **GIVEN** a plugin that calls `handles.track(handleA)` during a guest-fired-and-forgot host call
- **WHEN** the run ends and `onRunFinished` invokes `handles.drain()`
- **THEN** the user-supplied `close` function SHALL be invoked with `handleA`
- **AND** the helper's internal Set SHALL be empty after `drain` resolves

#### Scenario: Per-call release removes the handle before the closer runs

- **GIVEN** a plugin that called `handles.track(handleA)` and is about to call `handles.release(handleA)` from a per-call `finally`
- **WHEN** `release` is invoked
- **THEN** `handleA` SHALL be removed from the internal Set BEFORE the closer is awaited
- **AND** a concurrent `drain()` racing with `release` SHALL NOT process `handleA` a second time

#### Scenario: Closer errors are swallowed

- **GIVEN** a closer that throws synchronously or rejects asynchronously
- **WHEN** `release` or `drain` invokes the closer
- **THEN** the helper's promise SHALL resolve normally
- **AND** the error SHALL NOT propagate out of `release` or `drain`

## MODIFIED Requirements

### Requirement: createMailPlugin factory

The `createMailPlugin` factory SHALL return a `Plugin` whose worker-side handler emits a paired `system.request` / `system.response` (or `system.error`) under the `system.*` prefix with `name = "sendMail"` for each `sendMail` call. Pairing SHALL use the main-side `RunSequencer`'s `callId` mechanism.

The `system.request` event SHALL carry the `sendMail` arguments as `input` (with credentials redacted per existing rules). `system.response` SHALL carry `output` describing the sent envelope (message id, accepted recipients). `system.error` SHALL carry the serialized error.

The plugin SHALL allocate a fresh `nodemailer` `Transport` per call. The `Transport` SHALL be tracked via `createRunScopedHandles` so that any `Transport` not released by the per-call `finally` (e.g., because the guest fired the host call without awaiting) is closed at run end via `onRunFinished`. Both the per-call `release` and the `onRunFinished` `drain` SHALL invoke `transport.close()` (sync; idempotent under double-call against nodemailer 6.x).

#### Scenario: Successful sendMail emits paired events

- **GIVEN** guest code calls `await sendMail({ to, subject, body })` and the call succeeds
- **WHEN** the call returns
- **THEN** a `system.request` event SHALL be emitted with `name = "sendMail"`
- **AND** a `system.response` event SHALL follow with the matching ref via callId pairing

#### Scenario: Per-call transport is closed by the per-call finally

- **GIVEN** guest code calls `await sendMail({...})` and awaits the result
- **WHEN** the call resolves (success or failure)
- **THEN** the per-call `finally` SHALL invoke `handles.release(transport)`
- **AND** the transport's `close()` method SHALL have been invoked exactly once

#### Scenario: Fire-and-forgot transport is closed at run end

- **GIVEN** guest code that calls `sendMail({...})` without awaiting and the run ends before the dispatcher's await resolves
- **WHEN** `onRunFinished` runs
- **THEN** `handles.drain()` SHALL invoke `transport.close()` for the still-tracked transport
- **AND** the SMTP socket SHALL NOT persist into the next run on the same sandbox

### Requirement: createFetchPlugin factory

The sandbox-stdlib package SHALL export a `createFetchPlugin(opts?: { fetch?: FetchImpl }): Plugin` factory. When `opts.fetch` is omitted, the plugin SHALL close over the `hardenedFetch` export from the same package. The plugin SHALL declare `dependsOn: ["web-platform"]`. The plugin SHALL register a private guest function `$fetch/do` whose handler invokes the bound fetch implementation and returns the serialized response. The plugin's `source` blob SHALL install a WHATWG-compliant `globalThis.fetch` that captures `$fetch/do` and marshals `Request`/`Response` to/from the host. The descriptor SHALL declare `log: { request: "fetch" }` so each fetch call produces `fetch.request`/`fetch.response` or `fetch.error`.

The plugin SHALL track each in-flight request's `AbortController` via `createRunScopedHandles` and SHALL register `onRunFinished` such that any in-flight request still tracked at run end is aborted via `controller.abort()`. The audit-event close frame for the aborted request is synthesized by the main-thread `RunSequencer.finish()` per existing sandbox semantics; the abort exists for worker-time-fairness, not audit correctness.

#### Scenario: Production fetch uses hardenedFetch by default

- **GIVEN** `createFetchPlugin()` called with no arguments
- **WHEN** guest code calls `await fetch("https://public.example.com/")`
- **THEN** the host-side handler SHALL invoke `hardenedFetch` (DNS validation via the shared net-guard primitive, IANA blocklist, redirect re-check, 30s timeout)
- **AND** the request SHALL fail closed if any hardening check rejects

#### Scenario: Test fetch override

- **GIVEN** `createFetchPlugin({ fetch: mockFetch })` with `mockFetch` a test double
- **WHEN** guest code calls `await fetch("https://any/")`
- **THEN** `mockFetch` SHALL be invoked instead of `hardenedFetch`

#### Scenario: Fetch call produces request/response events

- **GIVEN** guest code awaits `fetch("https://public.example.com/")` and the request succeeds
- **WHEN** the call resolves
- **THEN** a `fetch.request` event SHALL be emitted with `createsFrame: true`
- **AND** a `fetch.response` event SHALL be emitted with `closesFrame: true`
- **AND** the response event's `ref` SHALL point to the request event's `seq`

#### Scenario: Fire-and-forgot fetch is aborted at run end

- **GIVEN** guest code that calls `fetch(...)` without awaiting and the run ends before the response arrives
- **WHEN** `onRunFinished` runs
- **THEN** `handles.drain()` SHALL invoke `controller.abort()` for the still-tracked request
- **AND** the in-flight request SHALL NOT continue consuming worker-thread time during the next run on the same sandbox

### Requirement: createSqlPlugin factory

The `createSqlPlugin` factory SHALL return a `Plugin` whose worker-side handler emits a paired `system.request` / `system.response` (or `system.error`) under the `system.*` prefix with `name = "executeSql"` for each `executeSql` call. Pairing SHALL use the main-side `RunSequencer`'s `callId` mechanism.

The `system.request` event SHALL carry the connection identifier and the redacted query/parameters as `input`. `system.response` SHALL carry the result-set summary as `output`. `system.error` SHALL carry the serialized error.

Per-query `statement_timeout` defaults and the public/SSL hardening rules established in the existing SQL plugin SHALL continue to apply.

The plugin SHALL track each per-call `postgres()` handle via `createRunScopedHandles` and SHALL register `onRunFinished: handles.drain` so that handles not released by the per-call `finally` are closed via `sql.end({ timeout: 0 })` at run end. The closer relies on porsager/postgres's documented idempotency (`if (ending) return ending`, `postgres@3.4.9 src/index.js:366`) so that the per-call `release` and the run-end `drain` are safe to race.

#### Scenario: Successful executeSql emits paired events

- **GIVEN** guest code calls `await executeSql(conn, query, params)` and the query succeeds
- **WHEN** the call returns
- **THEN** a `system.request` event SHALL be emitted with `name = "executeSql"`
- **AND** a `system.response` event SHALL follow with the matching ref via callId pairing

#### Scenario: Per-call SQL handle is closed by the per-call finally

- **GIVEN** guest code calls `await executeSql(conn, query, params)` and awaits the result
- **WHEN** the call resolves (success or failure)
- **THEN** the per-call `finally` SHALL invoke `handles.release(sql)`
- **AND** `sql.end({ timeout: 0 })` SHALL have been invoked

#### Scenario: Fire-and-forgot SQL handle is closed at run end

- **GIVEN** guest code that calls `executeSql(...)` without awaiting and the run ends before the query resolves
- **WHEN** `onRunFinished` runs
- **THEN** `handles.drain()` SHALL invoke `sql.end({ timeout: 0 })` for the still-tracked handle
- **AND** the postgres connection SHALL NOT persist into the next run on the same sandbox
