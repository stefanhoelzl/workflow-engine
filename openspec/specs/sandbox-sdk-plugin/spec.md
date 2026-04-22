# sandbox-sdk-plugin Specification

## Purpose
TBD - created by archiving change sandbox-plugin-architecture. Update Purpose after archive.
## Requirements
### Requirement: createSdkSupportPlugin factory

The SDK package SHALL export a `createSdkSupportPlugin(): Plugin` factory. The plugin SHALL declare `dependsOn: ["host-call-action"]`, using the imported `validateAction` from the host-call-action plugin's exports.

The plugin SHALL register a private guest function descriptor `__sdkDispatchAction` with signature `(name: string, input: unknown, handler: Callable, completer: Callable) => unknown`. The handler SHALL:

1. `ctx.request("action", name, { input }, async () => { ... })` — wraps the body
2. Invoke `validateAction(name, input)` (via `deps["host-call-action"].validateAction`)
3. Invoke the captured `handler(input)` callable
4. Invoke the captured `completer(raw)` callable to parse the output
5. Return the parsed output
6. Dispose both `handler` and `completer` in a `finally` block

The plugin's `source` blob SHALL install a locked `__sdk` object via `Object.defineProperty(globalThis, "__sdk", { value: Object.freeze({ dispatchAction: (name, input, handler, completer) => raw(name, input, handler, completer) }), writable: false, configurable: false, enumerable: false })` where `raw` is the captured `__sdkDispatchAction` private global. The `log` field on the descriptor SHALL be `{ request: "action" }`.

#### Scenario: __sdk.dispatchAction is the guest surface

- **GIVEN** a sandbox with `createSdkSupportPlugin()` composed
- **WHEN** user source evaluates `typeof globalThis.__sdk.dispatchAction`
- **THEN** the result SHALL be `"function"`
- **AND** `typeof globalThis.__sdkDispatchAction` SHALL be `"undefined"`

#### Scenario: __sdk binding is locked

- **GIVEN** a sandbox with `createSdkSupportPlugin()` composed
- **WHEN** user source evaluates `globalThis.__sdk = { dispatchAction: () => {} }`
- **THEN** the assignment SHALL throw in strict mode or silently no-op in sloppy mode
- **AND** `delete globalThis.__sdk` SHALL return false (non-configurable)

#### Scenario: __sdk object is frozen

- **GIVEN** a sandbox with `createSdkSupportPlugin()` composed
- **WHEN** user source evaluates `globalThis.__sdk.dispatchAction = () => {}`
- **THEN** the assignment SHALL throw in strict mode or silently no-op in sloppy mode

#### Scenario: Successful action emits request/response pair

- **GIVEN** an action with schema `{ foo: string }` and input `{ foo: "bar" }` that returns `{ result: 42 }`
- **WHEN** `__sdk.dispatchAction("processOrder", { foo: "bar" }, handler, completer)` is called
- **THEN** `action.request` event SHALL be emitted first with `createsFrame: true` and `input: { foo: "bar" }`
- **AND** `validateAction("processOrder", { foo: "bar" })` SHALL be invoked (no throw)
- **AND** the captured `handler` SHALL be invoked with `{ foo: "bar" }`
- **AND** the captured `completer` SHALL be invoked with the handler's return value
- **AND** `action.response` event SHALL be emitted with `closesFrame: true` and `output: { result: 42 }`
- **AND** `action.response.ref` SHALL equal `action.request.seq`

#### Scenario: Handler throws — action.error emitted

- **GIVEN** an action whose `handler` throws a `ValidationError`
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` SHALL be emitted first with `createsFrame: true`
- **AND** `action.error` event SHALL be emitted with `closesFrame: true`
- **AND** `action.error.error` SHALL be a serialized representation of the thrown error
- **AND** the original error SHALL propagate back through `__sdk.dispatchAction` to the caller

#### Scenario: Validation failure emits action.error

- **GIVEN** an action whose input fails Ajv validation (invalid shape)
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` SHALL be emitted with `createsFrame: true`
- **AND** `validateAction` SHALL throw
- **AND** `action.error` SHALL be emitted with `closesFrame: true` and the validation error payload
- **AND** the guest `handler` SHALL NOT be invoked

#### Scenario: Callable arguments auto-disposed

- **GIVEN** an action dispatch where `handler` and `completer` are captured as `Callable` via `Guest.callable()`
- **WHEN** the dispatch completes (success or failure)
- **THEN** both `Callable.dispose()` methods SHALL have been called
- **AND** the underlying `JSValueHandle`s SHALL be released to QuickJS

### Requirement: action() SDK export is a passthrough

The SDK's `action()` factory SHALL produce callables whose implementation is a thin wrapper that calls `globalThis.__sdk.dispatchAction(name, input, handler, completer)`. The SDK SHALL NOT reach into any other sandbox internals; all action-lifecycle logic SHALL live in the `createSdkSupportPlugin` plugin's worker-side handler.

#### Scenario: action() wraps dispatchAction

- **GIVEN** `action({ name: "myAction", handler: async (input) => input, outputSchema: z.object(...) })`
- **WHEN** the callable is invoked with `await myAction({ foo: "bar" })`
- **THEN** it SHALL call `globalThis.__sdk.dispatchAction("myAction", { foo: "bar" }, handler, (raw) => outputSchema.parse(raw))`
- **AND** return the result of that call

### Requirement: No runtime-appended source

The runtime SHALL NOT append `action-dispatcher.js` (or any other dispatcher source) to tenant workflow bundles. All action-dispatcher logic SHALL live in the SDK's support plugin.

#### Scenario: Bundle contains no appended dispatcher

- **GIVEN** a tenant workflow bundle produced by the vite plugin
- **WHEN** the runtime loads the bundle
- **THEN** no source SHALL be concatenated or appended to the user source
- **AND** the runtime SHALL pass the user source to `sandbox({ source: ... })` unmodified

