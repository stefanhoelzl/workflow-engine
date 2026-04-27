## MODIFIED Requirements

### Requirement: action factory returns typed callable

The `action(config)` export from the SDK SHALL produce a callable that, when invoked with input, calls `globalThis.__sdk.dispatchAction(config.name, input, config.handler)`. The callable SHALL return the result of that call. The SDK SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the sdk-support plugin via the host-call-action plugin's `validateActionOutput` export (per `sandbox-output-validation`). The SDK SHALL NOT contain any direct bridge logic, event emission, schema parsing, or lifecycle emission — all of that lives in the sdk-support plugin's host-side handler and in the host-call-action plugin's schema validators.

```ts
// SDK implementation:
export const action = (config) => async (input) =>
  globalThis.__sdk.dispatchAction(
    config.name,
    input,
    config.handler,
  );
```

The `handler` callback SHALL be captured by the sdk-support plugin as a `Callable` value (via `Guest.callable()`), invoked worker-side, and disposed in the plugin handler's `finally` block after each dispatch. The `config.outputSchema` object SHALL NOT cross the sandbox boundary at dispatch time — schema validators were rehydrated host-side at sandbox-construction time from the manifest's `outputSchema` entries (see `actions` "host-call-action plugin module").

Any extra positional argument that a stale tenant bundle passes as a fourth argument (legacy `(raw) => outputSchema.parse(raw)` completer) SHALL be silently ignored by the sdk-support plugin handler; host-side validation runs regardless (per `sandbox-output-validation` stale-guest tolerance).

#### Scenario: action() calls __sdk.dispatchAction with three arguments

- **GIVEN** `action({ name: "myAction", handler: async (input) => input, outputSchema: z.object({ foo: z.string() }) })`
- **WHEN** the callable is invoked with `{ foo: "bar" }`
- **THEN** `globalThis.__sdk.dispatchAction("myAction", { foo: "bar" }, handler)` SHALL be called
- **AND** the SDK-bundled callable SHALL NOT pass a fourth positional argument
- **AND** the returned value SHALL be the resolved result from `__sdk.dispatchAction`

### Requirement: sdk-support plugin shape

The SDK's `sdk-support` plugin module SHALL declare `dependsOn: ["host-call-action"]`, consuming both `validateAction` and `validateActionOutput` from the host-call-action plugin's exports.

The plugin SHALL register a private guest function descriptor `__sdkDispatchAction` with signature `(name: string, input: unknown, handler: Callable) => unknown`. The descriptor's `log` SHALL be `{ request: "action" }`, so the sandbox auto-wraps each call in an `action.request` / `action.response` / `action.error` frame. Within that wrap the handler SHALL:

1. Invoke `validateAction(name, input)` (via `deps["host-call-action"].validateAction`); on throw, the rejection propagates out of the auto-wrap and `action.error` fires.
2. Invoke the captured guest `handler(input)` callable, awaiting a raw value.
3. Invoke `validateActionOutput(name, raw)` on the host (via `deps["host-call-action"].validateActionOutput`) and return its validated result.
4. Dispose the captured `handler` in a `finally` block.

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

- **WHEN** user source evaluates `globalThis.__sdk.dispatchAction = () => {}`
- **THEN** the assignment SHALL throw in strict mode or silently no-op in sloppy mode

#### Scenario: Successful action emits request/response with host-validated output

- **GIVEN** an action with input schema `{foo: string}` and input `{foo: "bar"}` whose handler returns `{result: 42}`
- **WHEN** `__sdk.dispatchAction("processOrder", {foo: "bar"}, handler)` is called
- **THEN** `action.request` SHALL be emitted with `createsFrame: true` and `input: {foo: "bar"}`
- **AND** `validateAction("processOrder", {foo: "bar"})` SHALL be invoked (no throw)
- **AND** the captured `handler` SHALL be invoked with `{foo: "bar"}`
- **AND** `validateActionOutput("processOrder", {result: 42})` SHALL be invoked host-side (no throw)
- **AND** `action.response` SHALL be emitted with `closesFrame: true` and `output: {result: 42}`
- **AND** `action.response.ref` SHALL equal `action.request.seq`

#### Scenario: Handler throws — action.error emitted

- **GIVEN** an action whose handler throws
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` (createsFrame) SHALL fire first
- **AND** `action.error` SHALL be emitted with `closesFrame: true` and the serialized error
- **AND** the original error SHALL propagate back through `__sdk.dispatchAction`

#### Scenario: Input validation failure emits action.error

- **GIVEN** an action whose input fails schema validation
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` SHALL fire with `createsFrame: true`
- **AND** `validateAction` SHALL throw
- **AND** `action.error` SHALL fire with `closesFrame: true` and the validation payload
- **AND** the guest `handler` SHALL NOT be invoked

#### Scenario: Output validation failure emits action.error

- **GIVEN** an action with output schema `z.string()` whose handler returns `42`
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` SHALL fire with `createsFrame: true`
- **AND** the handler SHALL execute returning `42`
- **AND** `validateActionOutput` SHALL throw a ValidationError with `issues` on the host
- **AND** `action.error` SHALL fire with `closesFrame: true` and the validation payload
- **AND** the rejection SHALL propagate back before any value is returned

#### Scenario: Callable handler auto-disposed

- **GIVEN** an action dispatch where `handler` is captured as `Callable` via `Guest.callable()`
- **WHEN** the dispatch completes (success or failure)
- **THEN** `handler.dispose()` SHALL have been called exactly once

#### Scenario: Extra positional argument from a stale guest is ignored

- **GIVEN** a stale tenant bundle whose `action()` wrapper passes a fourth completer argument
- **WHEN** the dispatch fires
- **THEN** the plugin handler SHALL ignore the extra argument
- **AND** host-side `validateActionOutput(name, raw)` SHALL still run
- **AND** the dispatch outcome SHALL reflect only the host-side validator result
