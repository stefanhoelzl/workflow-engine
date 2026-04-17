## ADDED Requirements

### Requirement: WASI clock_time_get override

The sandbox worker SHALL install a WASI `clock_time_get` override at QuickJS VM creation. For `CLOCK_REALTIME` the override SHALL return `BigInt(Date.now()) * 1_000_000n` nanoseconds (pass-through to the host wall clock). For `CLOCK_MONOTONIC` the override SHALL return `(BigInt(Math.trunc(performance.now() * 1_000_000)) - anchorNs)` where `anchorNs` is the worker's monotonic anchor.

While a run context is active (i.e. `bridge.getRunContext()` returns non-null), each invocation of the override SHALL emit one InvocationEvent with `kind = "system.call"`, `name = "wasi.clock_time_get"`, `input = { clockId: "REALTIME" | "MONOTONIC" }`, and `output = { ns: <number> }`. Invocations that fire without a run context (VM initialization, WASI libc init, guest source evaluation before the first run) SHALL NOT emit events.

#### Scenario: Realtime read passes through and emits event during a run

- **GIVEN** a running sandbox with no clock controls
- **WHEN** guest code inside an active run invokes `Date.now()`
- **THEN** the returned value SHALL approximate the host wall-clock time at call time
- **AND** one `system.call` event with `name = "wasi.clock_time_get"`, `input.clockId = "REALTIME"`, and `output.ns` matching the returned value times `1_000_000` SHALL be emitted

#### Scenario: Monotonic read is anchored to the current run

- **GIVEN** a running sandbox
- **WHEN** guest code inside an active run invokes `performance.now()` as the first monotonic read of that run
- **THEN** the returned value SHALL be within a small epsilon of `0`
- **AND** a subsequent `performance.now()` later in the same run SHALL return a strictly greater non-negative value

#### Scenario: Pre-run clock reads do not emit events

- **GIVEN** a sandbox whose `handleInit` has completed but `handleRun` has not started
- **WHEN** any WASI `clock_time_get` read fires (including QuickJS PRNG seeding or workflow source IIFE construction)
- **THEN** no InvocationEvent SHALL be emitted for that read

### Requirement: WASI random_get override

The sandbox worker SHALL install a WASI `random_get` override at QuickJS VM creation. The override SHALL delegate to the host's `crypto.getRandomValues` to fill the requested region of WASM linear memory.

While a run context is active, each invocation SHALL emit one InvocationEvent with `kind = "system.call"`, `name = "wasi.random_get"`, `input = { bufLen: <number> }`, and `output = { bufLen: <number>, sha256First16: <hex> }` where `sha256First16` is the lowercase hex encoding of the first 16 bytes of `SHA-256(bytes)` and `bytes` are the entropy bytes returned to the guest.

The event SHALL NOT carry the returned entropy bytes in any form. Invocations without an active run context SHALL NOT emit events.

#### Scenario: Entropy read passes through and emits event during a run

- **GIVEN** a running sandbox
- **WHEN** guest code inside an active run invokes `crypto.getRandomValues(new Uint8Array(32))`
- **THEN** the buffer SHALL be filled with cryptographically random bytes from the host
- **AND** one `system.call` event with `name = "wasi.random_get"`, `input.bufLen = 32`, `output.bufLen = 32`, and `output.sha256First16` being a 32-character lowercase hex string SHALL be emitted

#### Scenario: Raw entropy bytes are never logged

- **GIVEN** a running sandbox
- **WHEN** any `wasi.random_get` event is emitted
- **THEN** the event payload SHALL NOT contain a field holding the raw returned bytes under any name
- **AND** the only fingerprint present SHALL be `output.sha256First16`

#### Scenario: Pre-run entropy reads do not emit events

- **GIVEN** a sandbox whose `handleInit` has completed but `handleRun` has not started
- **WHEN** any WASI `random_get` read fires (including WASI libc init)
- **THEN** no InvocationEvent SHALL be emitted for that read

### Requirement: WASI fd_write capture routed to sandbox Logger

The sandbox worker SHALL install a WASI `fd_write` override at QuickJS VM creation. The override SHALL decode the written bytes as UTF-8, line-buffer per file descriptor, and SHALL NOT pass bytes through to the host's `process.stdout` or `process.stderr`. On each completed line the worker SHALL post a `WorkerToMain` message `{ type: "log", level: "debug", message: "quickjs.fd_write", meta: { fd: <number>, text: <line-without-newline> } }`.

The main-thread sandbox handler SHALL route incoming `log` messages by invoking `logger[level](message, meta)` on the injected `Logger` (when `SandboxOptions.logger` is set). When no `Logger` has been injected, the main thread SHALL silently discard the message.

`fd_write` bytes SHALL NOT be emitted as InvocationEvents under any circumstance.

#### Scenario: Engine diagnostic is routed to injected Logger at debug level

- **GIVEN** a sandbox constructed with an injected `Logger` spy
- **WHEN** the WASI `fd_write` override is invoked with bytes representing `"some diagnostic\n"` on fd 2
- **THEN** the logger's `debug` method SHALL be called exactly once with `"quickjs.fd_write"` and `meta = { fd: 2, text: "some diagnostic" }`
- **AND** no InvocationEvent SHALL be emitted for the write

#### Scenario: fd_write traffic is silently dropped when no Logger is provided

- **GIVEN** a sandbox constructed without a `logger` option
- **WHEN** the WASI `fd_write` override is invoked with any bytes
- **THEN** no call to any logger method SHALL occur
- **AND** the host process `stdout` and `stderr` SHALL receive no bytes from this write
- **AND** no InvocationEvent SHALL be emitted

### Requirement: system.call event kind contract

The `@workflow-engine/core` package SHALL export `"system.call"` as a variant of `EventKind`. A `system.call` InvocationEvent SHALL carry both `input` and `output` in the same record and SHALL NOT have a paired counterpart event. It SHALL be a leaf in the invocation call tree — emitting a `system.call` SHALL NOT push or pop entries on the sandbox bridge's reference stack.

The event's `ref` field SHALL be `refStack.at(-1) ?? null`. The event's `seq` field SHALL be obtained from the bridge's next-seq counter. The event's `name` field SHALL identify the source (e.g. `"wasi.clock_time_get"`, `"wasi.random_get"`). Consumers that branch on `kind` SHALL treat `"system.call"` as an additive variant.

#### Scenario: system.call is emitted as a single record

- **GIVEN** a running sandbox
- **WHEN** a WASI clock or random read fires during an active run
- **THEN** exactly one InvocationEvent with `kind = "system.call"` SHALL be emitted for that read
- **AND** no `"system.response"` or `"system.error"` event SHALL be emitted with a matching `ref`

#### Scenario: system.call inherits call-site context via ref

- **GIVEN** a running sandbox whose guest code calls `__hostFetch` and inside the host `fetch` implementation a WASI `clock_time_get` fires
- **WHEN** the events are inspected
- **THEN** the `system.request` event for `host.fetch` SHALL have `seq = S`
- **AND** the `system.call` event for `wasi.clock_time_get` SHALL have `ref = S`
- **AND** the matching `system.response` event for `host.fetch` SHALL also have `ref = S`

### Requirement: Monotonic clock anchor lifecycle

The sandbox worker SHALL maintain a mutable `anchorNs` state used by the `CLOCK_MONOTONIC` branch of the WASI `clock_time_get` override. The anchor SHALL be set to `BigInt(Math.trunc(performance.now() * 1_000_000))` at worker initialization. The anchor SHALL be re-set to the current `BigInt(Math.trunc(performance.now() * 1_000_000))` value each time `bridge.setRunContext` is invoked for a new run.

Guest reads of `performance.now()` across reruns of a cached sandbox SHALL therefore start near zero at the beginning of every run, regardless of how much wall-clock time has elapsed between runs.

#### Scenario: Monotonic resets between runs on a cached sandbox

- **GIVEN** a cached sandbox that has completed one run in which `performance.now()` reached value V1
- **WHEN** a second run begins via `sandbox.run(...)`
- **AND** guest code in the second run invokes `performance.now()` as the first monotonic read
- **THEN** the returned value SHALL be within a small epsilon of `0`
- **AND** SHALL be strictly less than V1

### Requirement: SandboxOptions accepts an injected Logger

The `SandboxOptions` type exported from the sandbox package SHALL accept an optional `logger?: Logger` field. When present, the sandbox SHALL route incoming `WorkerToMain { type: "log" }` messages to that logger by invoking `logger[level](message, meta)`. When absent, the sandbox SHALL silently discard `log` messages.

The sandbox factory SHALL pass its own injected `Logger` to each sandbox it constructs via this option. Direct consumers of `sandbox()` MAY omit the option; omission SHALL NOT be an error.

#### Scenario: Factory propagates its Logger into constructed sandboxes

- **GIVEN** a `SandboxFactory` constructed with an injected Logger spy
- **WHEN** `factory.create(source)` resolves
- **AND** the resulting sandbox's WASI `fd_write` override fires with any decoded line
- **THEN** the factory's injected Logger SHALL receive the corresponding `debug` call

#### Scenario: Direct sandbox() call without a logger is valid

- **GIVEN** a direct `sandbox(source, methods)` call with no `options.logger`
- **WHEN** any `WorkerToMain { type: "log" }` message arrives from the worker
- **THEN** the main-thread handler SHALL discard the message without throwing

### Requirement: Sandbox Logger interface supports debug level

The `Logger` interface exposed at `packages/sandbox/src/factory.ts` SHALL define methods `info`, `warn`, `error`, and `debug`, each with signature `(message: string, meta?: Record<string, unknown>) => void`. The `debug` method SHALL be used by the sandbox to route `fd_write` traffic. Other internal usages MAY continue to use `info` and `warn` as before.

#### Scenario: Debug method is part of the Logger contract

- **GIVEN** any test or production construction of `SandboxFactory`
- **WHEN** the factory calls `logger.debug(msg, meta)` on its injected logger
- **THEN** the injected implementation SHALL handle the call without throwing

## MODIFIED Requirements

### Requirement: Safe globals — performance.now

The sandbox SHALL expose `performance.now()` via the QuickJS performance intrinsic, which reads time through the WASI `clock_time_get` syscall with `clockId = CLOCK_MONOTONIC`. The worker's `CLOCK_MONOTONIC` override SHALL return `(performance.now() × 1_000_000 ns) − anchorNs` where `anchorNs` is the sandbox's monotonic anchor, which is re-set at every `bridge.setRunContext`. Guest `performance.now()` SHALL therefore start near zero at the beginning of each run and increase monotonically within that run.

#### Scenario: performance.now returns monotonically increasing values within a run

- **GIVEN** a sandbox in an active run
- **WHEN** guest code calls `performance.now()` twice in sequence
- **THEN** the second value SHALL be greater than or equal to the first value

#### Scenario: performance.now starts near zero at the start of each run

- **GIVEN** a cached sandbox that has completed a prior run
- **WHEN** a new run begins and guest code calls `performance.now()` as the first monotonic read of that run
- **THEN** the returned value SHALL be within a small epsilon of `0`

## REMOVED Requirements

### Requirement: Caller-provided clock override

**Reason:** The requirement described a closure-valued `clock` option on `SandboxOptions` passed from caller to sandbox. With the worker-thread architecture, closures cannot cross `postMessage`, so this API is not implementable as written — and no code ever satisfied it. Deterministic clock control returns in a future change as a serializable descriptor option processed on the worker side.

**Migration:** Callers that need a fixed clock or a ledger-replay clock for deterministic runs SHALL await the phase-2 descriptor API. In the meantime, the sandbox's default behavior (`CLOCK_REALTIME` returns host wall-clock time; `CLOCK_MONOTONIC` is anchored at the start of each run) is the sole supported mode, and every read is now observable via `system.call` events.

### Requirement: Caller-provided randomness override

**Reason:** The requirement described a closure-valued `random` option on `SandboxOptions` passed from caller to sandbox. Same worker-thread postMessage constraint as the clock override — not implementable as written; no code ever satisfied it. Deterministic randomness control returns in a future change as a serializable descriptor option.

**Migration:** Callers that need seeded randomness or ledger-replay entropy SHALL await the phase-2 descriptor API. In the meantime, the sandbox uses the host's `crypto.getRandomValues` for all WASI `random_get` reads, and every read is now observable via `system.call` events (size and SHA-256 fingerprint; raw bytes are never logged).

### Requirement: Override options follow existing patterns

**Reason:** This requirement tied together the clock and randomness overrides into a shared option-parameter contract. Both overrides are removed above for the same architectural reason (closures cannot cross `postMessage`), so the binding requirement has no remaining subject.

**Migration:** The phase-2 descriptor API for control and replay modes will follow the same existing-patterns convention (optional fields on `SandboxOptions`, independently supplied), but the options will be tagged-union descriptors rather than closures.
