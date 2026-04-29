## ADDED Requirements

### Requirement: Guest→host boundary opacity (Callable envelope contract)

The bridge SHALL convert guest-originated throws crossing the host plugin boundary into structured `CallableResult` envelopes rather than rejected promises. Specifically:

- The `Callable` type SHALL have signature `(...args: GuestValue[]) => Promise<CallableResult>` where `CallableResult = { ok: true, value: GuestValue } | { ok: false, error: { name: string, message: string, stack: string } & Record<string, unknown> }`.
- `Callable.invoke` SHALL resolve (not reject) with `{ ok: false, error }` when the guest throws inside the invoked function. The `error` field SHALL carry the curated `GuestThrownError` shape: `.name` and `.message` from the guest exception, `.stack` set verbatim from the guest-side stack, and any enumerable own-properties of the guest exception (preserving structured discriminants per "Idempotent vm.newError extension").
- `Callable.invoke` SHALL resolve with `{ ok: true, value }` on guest-returned success.
- `Callable.invoke` SHALL continue to reject (not resolve) for engine-side failures: `CallableDisposedError` when the Callable was disposed before invocation, host-side `marshalArg` failures on unmarshallable input, and `vm`-disposed-mid-call situations. These rejections SHALL retain "fail loud" semantics — they signal engine bugs, not guest behaviour.
- Each envelope SHALL carry a non-enumerable Symbol-keyed brand under `Symbol.for("@workflow-engine/sandbox#callableResult")` with value `true`. The brand SHALL be attached via `Object.defineProperty` so it does not appear in `JSON.stringify`, `Object.keys`, or `structuredClone`-clone trees.

This requirement closes the symmetric guest→host boundary opposite the host→guest opacity rule (R-12). Guest-originated rejections previously escalated through Node's `unhandledRejection` path and terminated the worker when a host plugin discarded the rejection (e.g. fire-and-forget under a deferred Node task); the envelope contract eliminates the rejection-as-control-flow surface at the boundary, so the worker never dies on a guest-originated throw.

#### Scenario: Guest async throw resolves as envelope

- **GIVEN** a guest function `f` that returns a rejected promise with `new Error("boom")`
- **WHEN** a host plugin holds a `Callable` for `f` and `await`s `cb()`
- **THEN** the awaited value SHALL be `{ ok: false, error: { name: "Error", message: "boom", stack: <guest-stack> } }`
- **AND** the awaited value SHALL carry a `true` value at `Symbol.for("@workflow-engine/sandbox#callableResult")`
- **AND** the awaited value's brand property SHALL NOT be enumerable

#### Scenario: Guest sync throw resolves as envelope

- **GIVEN** a guest function `f` that does `throw new TypeError("bad")` synchronously
- **WHEN** a host plugin's `Callable` for `f` is invoked and awaited
- **THEN** the awaited value SHALL be `{ ok: false, error: { name: "TypeError", message: "bad", stack: <guest-stack> } }`
- **AND** the brand property SHALL be present and non-enumerable

#### Scenario: Guest success resolves as ok envelope

- **GIVEN** a guest function `f` that returns `42`
- **WHEN** a host plugin's `Callable` for `f` is invoked and awaited
- **THEN** the awaited value SHALL be `{ ok: true, value: 42 }` carrying the brand symbol

#### Scenario: Guest-thrown error preserves structured own-properties

- **GIVEN** a guest function `f` that does `throw Object.assign(new Error("auth-fail"), { kind: "auth", code: 401 })`
- **WHEN** a host plugin's `Callable` for `f` is invoked and awaited
- **THEN** the resulting `result.ok` SHALL be `false`
- **AND** `result.error.kind` SHALL be `"auth"`
- **AND** `result.error.code` SHALL be `401`

#### Scenario: Disposed Callable still rejects

- **GIVEN** a `Callable` whose underlying handle has been disposed via `callable.dispose()`
- **WHEN** the disposed callable is invoked and awaited
- **THEN** the awaited promise SHALL reject (not resolve) with a `CallableDisposedError`
- **AND** the rejection SHALL NOT carry the `CallableResult` brand

#### Scenario: A deferred Callable throw does not kill the worker

- **GIVEN** a guest workflow that schedules `setTimeout(() => { throw new Error("late") }, 0)` and then awaits a 50ms timer before returning successfully
- **WHEN** the run completes
- **THEN** the `RunResult` SHALL be `{ ok: true, ... }` (the handler's resolution)
- **AND** the worker thread SHALL remain alive
- **AND** the sandbox SHALL accept and complete a subsequent `run()` invocation without re-spawning the worker

### Requirement: pluginRequest auto-unwraps Callable envelopes

The `pluginRequest` function (`packages/sandbox/src/plugin.ts`) SHALL detect `CallableResult`-branded values returned from the wrapped function via the brand symbol `Symbol.for("@workflow-engine/sandbox#callableResult")` and route them onto the appropriate `prefix.response` / `prefix.error` close. When the wrapped `fn()` resolves to a branded envelope:

- If `envelope.ok === true`: emit `prefix.response` (close, paired with the `prefix.request` open's callId) with `output = envelope.value`. The outer promise SHALL resolve with the envelope (not the unwrapped value).
- If `envelope.ok === false`: emit `prefix.error` (close, paired with the open's callId) with `error = envelope.error` (passed through unchanged — the envelope's `error` field is already the curated `GuestThrownError` surface, no further serialisation). The outer promise SHALL resolve with the envelope. **The outer promise SHALL NOT reject.**

For non-envelope values (the existing path used by host dispatchers like fetch / mail / sql), `pluginRequest` retains its current behaviour: emit `prefix.response` with the raw value on success; emit `prefix.error` (with `serializeLifecycleError(err)`-shaped error) and rethrow the original exception on failure.

The non-rethrowing-on-envelope-error rule is load-bearing: rethrowing would re-create the chained-rejection escape route that is the source of the F-3 finding. Engine-side rejections (the rejection branch of the wrapped `fn()`'s promise that is NOT a Callable envelope) continue to rethrow.

#### Scenario: ok envelope produces system.response close

- **GIVEN** `pluginRequest(bridge, "system", { name: "setTimeout", input: { timerId: 7 } }, () => callable())` where `callable()` resolves with `{ ok: true, value: 42 }`
- **WHEN** the inner promise resolves
- **THEN** a `system.response` event SHALL be emitted with `name = "setTimeout"`, the matching close-callId, and `output = 42`
- **AND** the outer promise from `pluginRequest` SHALL resolve with the envelope `{ ok: true, value: 42 }`
- **AND** no `system.error` event SHALL be emitted

#### Scenario: error envelope produces system.error close without rethrow

- **GIVEN** `pluginRequest(bridge, "system", { name: "setTimeout", input: { timerId: 7 } }, () => callable())` where `callable()` resolves with `{ ok: false, error: { name: "Error", message: "boom", stack: "..." } }`
- **WHEN** the inner promise resolves
- **THEN** a `system.error` event SHALL be emitted with `name = "setTimeout"`, the matching close-callId, and `error = { name: "Error", message: "boom", stack: "..." }`
- **AND** the outer promise from `pluginRequest` SHALL resolve with the envelope `{ ok: false, error: ... }`
- **AND** the outer promise SHALL NOT reject

#### Scenario: Engine-bug rejection still rethrows

- **GIVEN** `pluginRequest(bridge, "system", { name: "setTimeout", input: { timerId: 7 } }, () => callable())` where `callable()` rejects with a `CallableDisposedError`
- **WHEN** the inner promise rejects
- **THEN** a `system.error` event SHALL be emitted with `error = serializeLifecycleError(rejection)`
- **AND** the outer promise from `pluginRequest` SHALL reject with the same `CallableDisposedError`

#### Scenario: Discarded outer promise does not crash worker on envelope-error

- **GIVEN** a host plugin that calls `pluginRequest(...)` and discards the returned promise (fire-and-forget under a deferred Node task)
- **WHEN** the wrapped `fn()` resolves with an error envelope
- **THEN** Node's `unhandledRejection` event SHALL NOT fire
- **AND** the worker thread SHALL remain alive

## MODIFIED Requirements

### Requirement: Guest-side error rethrow uses GuestThrownError

The sandbox's `callGuestFn` and `awaitGuestResult` paths SHALL construct `GuestThrownError` instances when surfacing a guest-side `JSException` to host plugin code. The original `JSException`'s `.name` and `.message` SHALL be preserved on the constructed `GuestThrownError`; the `JSException`'s `.stack` SHALL be set verbatim onto `GuestThrownError.stack`.

When the construction happens inside `Callable.invoke`'s code path (the only in-tree caller, used by `makeCallable`), the constructed `GuestThrownError` SHALL be surfaced through the `CallableResult` envelope's `error` field rather than rethrown as a host promise rejection (per "Guest→host boundary opacity (Callable envelope contract)"). The `GuestThrownError` instance is the source of the envelope's `error` field; structured own-properties (`.kind`, `.code`, etc.) preserved by `ensureExtendedNewError`'s host-side counterpart for guest exceptions are carried through onto the envelope's `error` field unchanged.

#### Scenario: Guest TypeError surfaces in envelope as GuestThrownError shape

- **GIVEN** a guest function `f` that does `throw new TypeError("bad")`
- **WHEN** a host plugin's `Callable` for `f` is invoked and the resulting promise resolves
- **THEN** the result SHALL be `{ ok: false, error }`
- **AND** `error.name` SHALL be `"TypeError"`
- **AND** `error.message` SHALL be `"bad"`
- **AND** `error.stack` SHALL be the guest-side stack verbatim
