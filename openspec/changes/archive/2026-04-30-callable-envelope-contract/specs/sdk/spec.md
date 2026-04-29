## MODIFIED Requirements

### Requirement: sdk-support plugin shape

The SDK's `sdk-support` plugin module SHALL declare `dependsOn: ["host-call-action"]`, consuming both `validateAction` and `validateActionOutput` from the host-call-action plugin's exports.

The plugin SHALL register a private guest function descriptor `__sdkDispatchAction` with signature `(name: string, input: unknown, handler: Callable) => unknown`. The descriptor's `log` SHALL be `{ request: "action" }`, so the sandbox auto-wraps each call in an `action.request` / `action.response` / `action.error` frame. Within that wrap the handler SHALL:

1. Invoke `validateAction(name, input)` (via `deps["host-call-action"].validateAction`); on throw, the rejection propagates out of the auto-wrap and `action.error` fires.
2. Invoke the captured guest `handler(input)` callable and inspect the returned `CallableResult` envelope (per `sandbox/spec.md` "Guest→host boundary opacity (Callable envelope contract)"). When `result.ok === false`, the handler SHALL `throw result.error;` so that the underlying `GuestThrownError` flows back through the surrounding `buildHandler` closure rule's pass-through branch (per `sandbox/spec.md` "Host/sandbox boundary opacity for thrown errors") and reaches the calling guest VM as the action's throw with `.name`, `.message`, and structured own-properties intact. When `result.ok === true`, the handler SHALL bind `raw = result.value` and continue.
3. Invoke `validateActionOutput(name, raw)` on the host (via `deps["host-call-action"].validateActionOutput`) and return its validated result.
4. Dispose the captured `handler` in a `finally` block.

The handler SHALL NOT use a `try/catch` around `await handler(input)` to recover from guest throws; rejection-as-control-flow is no longer the surfacing mechanism for guest throws under the envelope contract. The `try/catch` previously needed for output validation translation (`translateValidatorThrow`) remains, applied only to the `validateActionOutput` call.

The dispatcher signature SHALL NOT accept a `completer` callable. Any extra positional argument passed by a stale guest SHALL be ignored; validation SHALL run host-side regardless. This keeps the security property intact even if a tenant bundle lags behind the new SDK shape (per `sandbox-output-validation`).

The plugin's `guest()` export (bundled as `descriptor.guestSource` by the vite plugin) SHALL install a locked `__sdk` object via `Object.defineProperty(globalThis, "__sdk", { value: Object.freeze({ dispatchAction: (name, input, handler) => raw(name, input, handler) }), writable: false, configurable: false, enumerable: false })` where `raw` is the captured `__sdkDispatchAction` private global. This is the canonical example of SECURITY.md §2 R-2 (locked host-callable global).

#### Scenario: __sdk.dispatchAction is the guest surface

- **GIVEN** a sandbox with the `sdk-support` plugin composed
- **WHEN** user source evaluates `typeof globalThis.__sdk.dispatchAction`
- **THEN** the result SHALL be `"function"`
- **AND** `typeof globalThis.__sdkDispatchAction` SHALL be `"undefined"`

#### Scenario: __sdk binding is locked

- **WHEN** user source evaluates `globalThis.__sdk = { dispatchAction: () => {} }`
- **THEN** the assignment SHALL throw in strict mode or silently no-op in sloppy mode
- **AND** `delete globalThis.__sdk` SHALL return false (non-configurable)

#### Scenario: __sdk object is frozen

- **GIVEN** the `__sdk` global as installed by sdk-support
- **WHEN** user source evaluates `globalThis.__sdk.dispatchAction = () => {}`
- **THEN** the assignment SHALL fail (frozen object)
- **AND** the original `dispatchAction` reference SHALL remain callable

#### Scenario: Action handler throw surfaces via envelope and rethrow

- **GIVEN** an `action` whose handler does `throw new Error("auth-fail")`
- **WHEN** the action is invoked from within another action via `__sdk.dispatchAction`
- **THEN** the `await handler(input)` call inside the dispatcher SHALL resolve with `{ ok: false, error: { name: "Error", message: "auth-fail", stack: <guest-stack> } }`
- **AND** the dispatcher SHALL throw `result.error` after envelope inspection
- **AND** the surrounding `buildHandler` closure SHALL pass the `GuestThrownError` through unchanged onto the calling guest VM
- **AND** the calling guest's `try { await action() } catch (err) { ... }` SHALL receive an error whose `.name === "Error"` and `.message === "auth-fail"`
- **AND** the outer wrap's `action.error` close event SHALL be emitted with the same error shape
