## MODIFIED Requirements

### Requirement: web-platform plugin — reportError and microtask exception routing

The plugin SHALL install `globalThis.reportError` as a function that dispatches a cancelable `ErrorEvent` on `globalThis`; if the event is not default-prevented, the function SHALL forward a serialized payload to the captured private `__reportErrorHost` descriptor, which emits a `system.exception` leaf event.

The plugin SHALL also wrap `queueMicrotask` so uncaught exceptions inside a microtask route through `reportError` rather than silently terminating the microtask queue. The wrapped `globalThis.queueMicrotask(callback)` SHALL preserve the WHATWG shape.

`__reportErrorHost` SHALL be a private (non-public) `GuestFunctionDescription`; after Phase 2, the IIFE SHALL have captured it into its closure, and Phase 3 SHALL delete `globalThis.__reportErrorHost` so user source cannot see it.

#### Scenario: Uncaught microtask exception routes through reportError

- **GIVEN** guest code calls `queueMicrotask(() => { throw new Error("boom") })`
- **WHEN** the microtask fires
- **THEN** `reportError` SHALL be invoked with the thrown error
- **AND** a `system.exception` leaf event SHALL be emitted unless a listener called `preventDefault()` on the dispatched ErrorEvent

#### Scenario: __reportErrorHost is not guest-visible

- **WHEN** user source (Phase 4) evaluates `typeof globalThis.__reportErrorHost`
- **THEN** the result SHALL be `"undefined"`

### Requirement: console plugin — log methods emit leaf events

The console plugin SHALL install `globalThis.console` with `log`, `info`, `warn`, `error`, `debug` methods. Each method SHALL emit one `system.call` leaf event per call carrying:

- `name`: `"console.log"`, `"console.info"`, `"console.warn"`, `"console.error"`, or `"console.debug"` matching the called method.
- `input`: `{ args: unknown[] }` containing the marshalled arguments.

The event SHALL NOT carry `output` or `error`. The console methods SHALL NOT throw if argument marshalling fails; the event SHALL omit the offending argument and SHALL include a placeholder marker.

#### Scenario: console.log emits one system.call event

- **GIVEN** guest code calls `console.log("hello", { a: 1 })`
- **WHEN** the call returns
- **THEN** exactly one InvocationEvent SHALL be emitted with `kind = "system.call"`, `name = "console.log"`, `input.args = ["hello", { a: 1 }]`

### Requirement: timers plugin — setTimeout / setInterval / clearTimeout / clearInterval

The timers plugin SHALL install `globalThis.setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`. Each registration SHALL emit one `system.call` leaf event per call. Each timer firing (callback execution) SHALL emit a paired `system.request` / `system.response` (or `system.request` / `system.error` on throw) under the `system.*` prefix, with `name` identifying the operation:

- `system.call name="setTimeout"` — emitted on registration. `input: { delay: number, timerId: number }`.
- `system.call name="setInterval"` — emitted on registration. Same input shape.
- `system.call name="clearTimeout"` — emitted on explicit clear of a known pending id, or by run-end auto-cleanup. `input: { timerId: number }`. SHALL NOT be emitted for clears targeting unknown or already-disposed ids.
- `system.call name="clearInterval"` — same as `clearTimeout` for interval timers.
- `system.request name="setTimeout"` (or `"setInterval"`) — emitted immediately before invoking the guest callback. `input: { timerId: number }`.
- `system.response name="setTimeout"` (or `"setInterval"`) — emitted on normal callback return. `input: { timerId }`, `output` SHALL be the callback's return value when JSON-serialisable, otherwise omitted.
- `system.error name="setTimeout"` (or `"setInterval"`) — emitted when the callback throws. `input: { timerId }`, `error: { message, stack }`. SHALL NOT promote to `trigger.error`. For `setInterval`, subsequent ticks SHALL continue until cleared.

The pairing of `system.request` and `system.response`/`system.error` for callback firings SHALL use the main-side `RunSequencer`'s `callId` mechanism (worker assigns a callId on the open; close echoes it).

#### Scenario: setTimeout registration emits a leaf

- **GIVEN** guest code calls `setTimeout(cb, 100)` returning `timerId = 7`
- **WHEN** the call returns
- **THEN** exactly one `system.call` event SHALL be emitted with `name = "setTimeout"`, `input = { delay: 100, timerId: 7 }`
- **AND** no `system.request` event SHALL be emitted at registration

#### Scenario: Timer firing emits paired request/response under system.*

- **GIVEN** a registered `setTimeout` that fires its callback successfully
- **WHEN** the callback completes
- **THEN** a `system.request` event SHALL precede the callback execution with `name = "setTimeout"`, `input = { timerId }`
- **AND** a `system.response` event SHALL follow with the matching ref via callId pairing

#### Scenario: Interval continues after an errored tick

- **GIVEN** a `setInterval(cb, 10)` whose first tick throws
- **WHEN** the first tick fires and emits `system.error` with `name = "setInterval"`
- **THEN** the host SHALL NOT call `clearInterval` on that timer
- **AND** subsequent ticks SHALL produce further `system.request` / `system.response` or `system.error` pairs until the handler returns or the guest clears the timer

### Requirement: fetch plugin — global fetch wraps __hostFetch

The fetch plugin SHALL install `globalThis.fetch` as a wrapper that emits a paired `system.request` / `system.response` (or `system.error` on failure) under the `system.*` prefix with `name = "fetch"`. The pairing SHALL use the main-side `RunSequencer`'s `callId` mechanism.

The `system.request` event SHALL carry `input: { method, url, headers? }`. The `system.response` event SHALL carry `output: { status, headers, body? }`. The `system.error` event SHALL carry `error: { message, stack }`. Body fields SHALL respect existing redaction rules.

#### Scenario: Successful fetch emits paired system.request / system.response

- **GIVEN** guest code calls `await fetch("https://example.com")` and the call succeeds
- **WHEN** the call returns
- **THEN** a `system.request` event SHALL precede the call with `name = "fetch"`, `input.url = "https://example.com"`
- **AND** a `system.response` event SHALL follow with the matching ref via callId pairing

#### Scenario: Failed fetch emits system.error

- **GIVEN** guest code calls `await fetch("https://blocked.invalid")` and the host returns an error
- **WHEN** the call rejects
- **THEN** a `system.error` event SHALL be emitted with `name = "fetch"`, `error.message` populated

### Requirement: createMailPlugin factory

The `createMailPlugin` factory SHALL return a `Plugin` whose worker-side handler emits a paired `system.request` / `system.response` (or `system.error`) under the `system.*` prefix with `name = "sendMail"` for each `sendMail` call. Pairing SHALL use the main-side `RunSequencer`'s `callId` mechanism.

The `system.request` event SHALL carry the `sendMail` arguments as `input` (with credentials redacted per existing rules). `system.response` SHALL carry `output` describing the sent envelope (message id, accepted recipients). `system.error` SHALL carry the serialized error.

#### Scenario: Successful sendMail emits paired events

- **GIVEN** guest code calls `await sendMail({ to, subject, body })` and the call succeeds
- **WHEN** the call returns
- **THEN** a `system.request` event SHALL be emitted with `name = "sendMail"`
- **AND** a `system.response` event SHALL follow with the matching ref via callId pairing

### Requirement: createSqlPlugin factory

The `createSqlPlugin` factory SHALL return a `Plugin` whose worker-side handler emits a paired `system.request` / `system.response` (or `system.error`) under the `system.*` prefix with `name = "executeSql"` for each `executeSql` call. Pairing SHALL use the main-side `RunSequencer`'s `callId` mechanism.

The `system.request` event SHALL carry the connection identifier and the redacted query/parameters as `input`. `system.response` SHALL carry the result-set summary as `output`. `system.error` SHALL carry the serialized error.

Per-query `statement_timeout` defaults and the public/SSL hardening rules established in the existing SQL plugin SHALL continue to apply.

#### Scenario: Successful executeSql emits paired events

- **GIVEN** guest code calls `await executeSql(conn, query, params)` and the query succeeds
- **WHEN** the call returns
- **THEN** a `system.request` event SHALL be emitted with `name = "executeSql"`
- **AND** a `system.response` event SHALL follow with the matching ref via callId pairing

### Requirement: SQL event param-value redaction

`system.request` and `system.response` events emitted by the SQL plugin SHALL redact parameter values per the existing redaction rules (configurable via plugin config). The redaction SHALL apply uniformly regardless of the prefix consolidation; updating from `sql.*` to `system.*` SHALL NOT weaken redaction.

#### Scenario: Parameter values are redacted in events

- **GIVEN** an SQL plugin configured with the default redaction rule
- **WHEN** guest code calls `executeSql(conn, "SELECT $1", ["secret"])`
- **THEN** the emitted `system.request` event's input SHALL NOT contain the literal value `"secret"`
