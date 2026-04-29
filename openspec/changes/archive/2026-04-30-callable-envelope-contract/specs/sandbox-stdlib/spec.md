## ADDED Requirements

### Requirement: timers plugin — fire-and-forget under Callable envelope contract

The timers plugin's `fire()` site (the host callback registered with Node `setTimeout` / `setInterval` for each pending guest timer) SHALL invoke the captured guest `Callable` via `ctx.request("system", { name, input: { timerId } }, () => entry.callable())` and SHALL discard the outer promise returned by `ctx.request`. The plugin SHALL rely on the Callable envelope contract (per `sandbox/spec.md` "Guest→host boundary opacity (Callable envelope contract)") and `pluginRequest`'s envelope auto-unwrap (per `sandbox/spec.md` "pluginRequest auto-unwraps Callable envelopes") for safe fire-and-forget semantics: a guest throw inside the timer callback SHALL surface as a `system.error` close on the timer's request frame, and the discarded outer promise SHALL resolve cleanly without escalating to Node's `unhandledRejection` path.

The plugin SHALL NOT install any local `try/catch` or `.catch` around the `ctx.request` call to suppress rejection propagation. The contract rule is enforced by the bridge and pluginRequest, not by per-plugin defensive code; adding plugin-local error handling would obscure the architectural choke point.

#### Scenario: setTimeout callback throw surfaces as system.error close, worker survives

- **GIVEN** a sandbox running a guest workflow that schedules `setTimeout(() => { throw new Error("late") }, 0)` and then awaits a 50ms timer before resolving its handler
- **WHEN** the run completes
- **THEN** the run SHALL resolve with `{ ok: true, ... }` reflecting the handler's resolution
- **AND** the event stream SHALL contain a `system.request` open with `name = "setTimeout"` followed by a `system.error` close with `name = "setTimeout"` and `error.name = "Error"`, `error.message = "late"`
- **AND** the worker thread SHALL remain alive
- **AND** the sandbox SHALL accept and complete a subsequent `run()` invocation

#### Scenario: setInterval continues firing after a tick throws

- **GIVEN** a sandbox running a guest workflow that schedules `setInterval(() => { throw new Error("tick-fail") }, 10)` and then awaits a 100ms timer before resolving
- **WHEN** the run completes
- **THEN** the event stream SHALL contain multiple `system.request` / `system.error` pairs for `name = "setInterval"`, one per tick fired before handler resolution
- **AND** the run SHALL resolve with `{ ok: true, ... }`
- **AND** the host SHALL NOT call `clearInterval` on the timer in response to the throws

#### Scenario: timers plugin does not catch the discarded outer promise locally

- **GIVEN** the timers plugin source
- **WHEN** the source is inspected
- **THEN** the `fire()` invocation site SHALL NOT contain a `try/catch` or `.catch(...)` wrapping the `ctx.request(...)` call
- **AND** the outer promise from `ctx.request(...)` SHALL be discarded without local observation
