## ADDED Requirements

### Requirement: createSdkSupportPlugin factory

The SDK package SHALL export a `createSdkSupportPlugin(): Plugin` factory. The plugin SHALL declare `dependsOn: ["host-call-action"]`, consuming both `validateAction` and `validateActionOutput` from the host-call-action plugin's exports.

The plugin SHALL register a private guest function descriptor `__sdkDispatchAction` with signature `(name: string, input: unknown, handler: Callable) => unknown`. The handler SHALL:

1. `ctx.request("action", name, { input }, async () => { ... })` — wraps the body so `action.request` / `action.response` / `action.error` events frame the dispatch.
2. Invoke `validateAction(name, input)` (via `deps["host-call-action"].validateAction`); on throw, the rejection propagates out of the request wrapper and `action.error` fires.
3. Invoke the captured guest `handler(input)` callable, awaiting a raw value.
4. Invoke `validateActionOutput(name, raw)` on the host (via `deps["host-call-action"].validateActionOutput`) and return its validated result.
5. Dispose the captured `handler` in a `finally` block.

The dispatcher signature SHALL NOT accept a `completer` callable. Any extra positional argument passed by a stale guest SHALL be ignored; validation SHALL run host-side regardless. This keeps the security property intact even if a tenant bundle lags behind the new SDK shape (per `sandbox-output-validation`).

The plugin's `source` blob SHALL install a locked `__sdk` object via `Object.defineProperty(globalThis, "__sdk", { value: Object.freeze({ dispatchAction: (name, input, handler) => raw(name, input, handler) }), writable: false, configurable: false, enumerable: false })` where `raw` is the captured `__sdkDispatchAction` private global. The `log` field on the descriptor SHALL be `{ request: "action" }`. This is the canonical example of SECURITY.md §2 R-2 (locked host-callable global).

#### Scenario: __sdk.dispatchAction is the guest surface

- **GIVEN** a sandbox with `createSdkSupportPlugin()` composed
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

- **GIVEN** an action whose input fails Ajv validation
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

### Requirement: action() SDK export is a passthrough

The SDK's `action()` factory SHALL produce callables whose implementation is a thin wrapper calling `globalThis.__sdk.dispatchAction(name, input, handler)`. The wrapper SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the sdk-support plugin via the host-call-action plugin's `validateActionOutput` export. The SDK SHALL NOT reach into any other sandbox internals; all action-lifecycle logic lives in `createSdkSupportPlugin`'s worker-side handler.

#### Scenario: action() wraps dispatchAction

- **GIVEN** `action({ name: "myAction", input: z.object(...), output: z.object(...), handler: async (input) => input })`
- **WHEN** the callable is invoked with `await myAction({foo: "bar"})`
- **THEN** it SHALL call `globalThis.__sdk.dispatchAction("myAction", {foo: "bar"}, handler)`
- **AND** return the result
- **AND** it SHALL NOT pass any fourth positional argument

### Requirement: No runtime-appended dispatcher source

The runtime SHALL NOT append `action-dispatcher.js` (or any other dispatcher source) to tenant workflow bundles. All action-dispatcher logic lives in the SDK's `createSdkSupportPlugin`. This is cross-referenced from `workflow-registry` (Sandbox loading) and `sandbox` (plugin composition) for runtime enforcement.

#### Scenario: Bundle loaded without source appending

- **GIVEN** a tenant workflow bundle produced by the vite plugin
- **WHEN** the runtime constructs the sandbox
- **THEN** `sandbox({source: <bundle>, plugins: [...]})` SHALL be invoked with `source` unchanged
- **AND** no dispatcher source SHALL be concatenated, prepended, or appended
