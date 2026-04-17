## ADDED Requirements

### Requirement: Safe globals — EventTarget

The sandbox SHALL expose `globalThis.EventTarget` as a WHATWG EventTarget implementation, provided by the `event-target-shim` npm package (v6.x) compiled into the sandbox polyfill IIFE. No host-bridge method is used; all listener state lives in the QuickJS heap. This global is required by the WinterCG Minimum Common API.

#### Scenario: new EventTarget() is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new EventTarget() instanceof EventTarget`
- **THEN** the result SHALL be `true`

#### Scenario: addEventListener delivers dispatched events

- **GIVEN** a fresh `EventTarget` with a listener registered via `et.addEventListener("x", cb)`
- **WHEN** guest code calls `et.dispatchEvent(new Event("x"))`
- **THEN** `cb` SHALL be invoked with an `Event` whose `type === "x"` and whose `target === et` and `currentTarget === et`

#### Scenario: once option auto-removes the listener after first dispatch

- **GIVEN** a listener registered via `et.addEventListener("x", cb, { once: true })`
- **WHEN** `et.dispatchEvent(new Event("x"))` is called twice
- **THEN** `cb` SHALL be invoked exactly once

#### Scenario: signal option auto-removes the listener on signal abort

- **GIVEN** a listener registered via `et.addEventListener("x", cb, { signal })`
- **WHEN** `signal` aborts and then `et.dispatchEvent(new Event("x"))` is called
- **THEN** `cb` SHALL NOT be invoked

#### Scenario: dispatchEvent re-entrancy uses a listener snapshot

- **GIVEN** a listener that calls `et.addEventListener("x", otherCb)` for a new listener during dispatch
- **WHEN** the current dispatch completes
- **THEN** `otherCb` SHALL NOT be invoked for the current dispatch (it becomes eligible for the next dispatch)

### Requirement: Safe globals — Event

The sandbox SHALL expose `globalThis.Event` as a constructible class from the same `event-target-shim` source. All guest-constructed Events SHALL have `isTrusted === false`.

#### Scenario: Event constructor accepts type and init dictionary

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new Event("x", { cancelable: true, bubbles: true })`
- **THEN** the result SHALL have `type === "x"`, `cancelable === true`, `bubbles === true`, `isTrusted === false`, `defaultPrevented === false`

#### Scenario: preventDefault honors cancelable flag

- **GIVEN** a cancelable Event being dispatched
- **WHEN** a listener calls `event.preventDefault()`
- **THEN** `dispatchEvent` SHALL return `false` and `event.defaultPrevented` SHALL be `true`

#### Scenario: preventDefault on non-cancelable Event has no effect

- **GIVEN** a non-cancelable Event
- **WHEN** a listener calls `event.preventDefault()`
- **THEN** `event.defaultPrevented` SHALL remain `false`

#### Scenario: stopImmediatePropagation prevents subsequent listeners

- **GIVEN** two listeners for the same event type
- **WHEN** the first listener calls `event.stopImmediatePropagation()`
- **THEN** the second listener SHALL NOT be invoked

### Requirement: Safe globals — ErrorEvent

The sandbox SHALL expose `globalThis.ErrorEvent` as a constructible class extending `Event`, with readonly `message`, `filename`, `lineno`, `colno`, and `error` properties initialised from the constructor init dictionary. ErrorEvent is dispatched by the evolved `reportError` shim and by the `queueMicrotask` wrap.

#### Scenario: ErrorEvent carries error and message

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new ErrorEvent("error", { error: new Error("boom"), message: "boom" })`
- **THEN** the result SHALL have `type === "error"`, `error.message === "boom"`, `message === "boom"`, and `isTrusted === false`

### Requirement: Safe globals — AbortController

The sandbox SHALL expose `globalThis.AbortController` as a hand-written pure-JS class whose `signal` property is a fresh `AbortSignal` instance. `abort(reason?)` SHALL set `signal.aborted === true`, record the reason (defaulting to `new DOMException("signal is aborted without reason", "AbortError")` when none given), and dispatch an `abort` Event on the signal. Subsequent `abort()` calls SHALL be no-ops.

#### Scenario: new AbortController().signal is an AbortSignal instance

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new AbortController().signal`
- **THEN** the result SHALL be an `AbortSignal` instance whose `aborted === false`

#### Scenario: abort(reason) sets aborted and reason, dispatches abort event

- **GIVEN** an `AbortController` with a listener on `controller.signal`
- **WHEN** guest code calls `controller.abort(new Error("test"))`
- **THEN** `controller.signal.aborted` SHALL be `true`, `controller.signal.reason.message === "test"`, and the listener SHALL have been invoked exactly once

#### Scenario: abort without reason uses DOMException AbortError

- **GIVEN** a fresh `AbortController`
- **WHEN** guest code calls `controller.abort()`
- **THEN** `controller.signal.reason` SHALL be a `DOMException` with `name === "AbortError"`

#### Scenario: abort is idempotent

- **GIVEN** an `AbortController` that has already been aborted
- **WHEN** guest code calls `controller.abort(anotherReason)`
- **THEN** `controller.signal.reason` SHALL remain the original reason and no additional `abort` Event SHALL fire

### Requirement: Safe globals — AbortSignal

The sandbox SHALL expose `globalThis.AbortSignal` as a hand-written class extending `EventTarget`. Instances SHALL expose `aborted`, `reason`, and `throwIfAborted()`. The class SHALL provide three static factories: `AbortSignal.abort(reason?)`, `AbortSignal.timeout(ms)`, and `AbortSignal.any(signals)`. Direct instantiation via `new AbortSignal()` is permitted but only useful for subclassing — `AbortController` is the normal construction path. `AbortSignal.timeout` uses the allowlisted `setTimeout` bridge; no new host surface is introduced.

#### Scenario: throwIfAborted throws the stored reason

- **GIVEN** an aborted signal with `reason === someError`
- **WHEN** guest code calls `signal.throwIfAborted()`
- **THEN** the call SHALL throw exactly `someError`

#### Scenario: AbortSignal.abort(reason) returns a pre-aborted signal

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `AbortSignal.abort(new Error("x"))`
- **THEN** the result SHALL have `aborted === true` and `reason.message === "x"`

#### Scenario: AbortSignal.timeout(ms) aborts after the delay with TimeoutError

- **GIVEN** `const s = AbortSignal.timeout(50)`
- **WHEN** 50ms elapse
- **THEN** `s.aborted` SHALL be `true` and `s.reason` SHALL be a `DOMException` with `name === "TimeoutError"`

#### Scenario: AbortSignal.any composes; aborts when any input aborts

- **GIVEN** three signals `a`, `b`, `c` and `const composite = AbortSignal.any([a, b, c])`
- **WHEN** `b` aborts with reason `R`
- **THEN** `composite.aborted === true` and `composite.reason === R`

#### Scenario: AbortSignal.any returns a pre-aborted signal when any input is already aborted

- **GIVEN** signal `a` that is already aborted with reason `R`
- **WHEN** guest code evaluates `AbortSignal.any([a, b])`
- **THEN** the returned signal SHALL already have `aborted === true` and `reason === R`

### Requirement: Safe globals — DOMException

The sandbox SHALL expose `globalThis.DOMException` as provided natively by the `quickjs-wasi` WASM extension (no polyfill). DOMException SHALL construct with `(message, name)` and provide `name` and `message` properties; instances SHALL satisfy `instanceof Error` and `instanceof DOMException`. DOMException is consumed by `AbortController`/`AbortSignal` for default abort and timeout reasons.

#### Scenario: DOMException is a constructible function

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `typeof DOMException`
- **THEN** the result SHALL be `"function"`

#### Scenario: DOMException instances carry name and message

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const e = new DOMException("oops", "AbortError")`
- **THEN** `e.name === "AbortError"`, `e.message === "oops"`, `e instanceof Error === true`, `e instanceof DOMException === true`

### Requirement: Guest-side microtask exception routing

The sandbox SHALL wrap `globalThis.queueMicrotask` so that an exception thrown by the queued callback is caught and forwarded to `globalThis.reportError(err)`. This routes microtask errors through the same `ErrorEvent`/`__reportError` pipeline as any other reported error.

#### Scenario: exception in microtask dispatches ErrorEvent to global listener

- **GIVEN** a listener registered via `self.addEventListener("error", handler)`
- **WHEN** guest code calls `queueMicrotask(() => { throw new Error("boom"); })` and the microtask drains
- **THEN** `handler` SHALL be invoked with an `ErrorEvent` whose `error.message === "boom"`

## MODIFIED Requirements

### Requirement: Safe globals — self

The sandbox SHALL expose `globalThis.self` as a reference to `globalThis` itself. The identity `self === globalThis` is preserved by reference assignment. `globalThis` additionally inherits `EventTarget.prototype` (see `Safe globals — EventTarget`), making `self instanceof EventTarget === true` and giving `self.addEventListener`/`self.removeEventListener`/`self.dispatchEvent` functional access via non-enumerable own-properties. This global is required by the WinterCG Minimum Common API for feature-detection compatibility with npm libraries.

#### Scenario: self reflects globalThis

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `self === globalThis`
- **THEN** the result SHALL be `true`

#### Scenario: self is an EventTarget

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `self instanceof EventTarget`
- **THEN** the result SHALL be `true`

#### Scenario: EventTarget methods on self are non-enumerable own-properties

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `Object.keys(globalThis)`
- **THEN** the result SHALL NOT include `addEventListener`, `removeEventListener`, or `dispatchEvent`
- **AND** `Object.getOwnPropertyNames(globalThis)` SHALL include all three

#### Scenario: self.addEventListener receives dispatched events

- **GIVEN** a listener registered via `self.addEventListener("x", cb)`
- **WHEN** guest code calls `self.dispatchEvent(new Event("x"))`
- **THEN** `cb` SHALL be invoked exactly once

### Requirement: Safe globals — reportError

The sandbox SHALL expose `globalThis.reportError(error)` as a guest-side shim that (a) constructs a cancelable `ErrorEvent` carrying the reported value in `event.error` and the error's message in `event.message`, (b) dispatches that event on `globalThis`, and (c) if the event was not default-prevented, serializes the error into a JSON payload `{ name, message, stack?, cause? }` and invokes the `__reportError` host-bridge method. The `cause` field SHALL be recursively serialized using the same schema when present. Each field read SHALL be guarded against throwing getters; on any field-read failure the shim SHALL substitute a sentinel string without propagating the throw into guest code.

#### Scenario: reportError dispatches ErrorEvent before host forwarding

- **GIVEN** a sandbox with `__reportError` host implementation capturing calls and a listener `self.addEventListener("error", handler)`
- **WHEN** guest code calls `reportError(new Error("oops"))`
- **THEN** `handler` SHALL be invoked with an `ErrorEvent` whose `error.message === "oops"`
- **AND** the host implementation SHALL receive a payload with `name: "Error"`, `message: "oops"`, and a `stack` string

#### Scenario: preventDefault() suppresses host forwarding

- **GIVEN** a listener that calls `event.preventDefault()` on the reported error event
- **WHEN** guest code calls `reportError(new Error("oops"))`
- **THEN** the host `__reportError` implementation SHALL NOT be invoked

#### Scenario: reportError accepts non-Error values

- **GIVEN** a sandbox
- **WHEN** guest code calls `reportError("a string")`
- **THEN** the host implementation SHALL receive `{ name: "Error", message: "a string" }` (no stack), provided no listener prevents default
