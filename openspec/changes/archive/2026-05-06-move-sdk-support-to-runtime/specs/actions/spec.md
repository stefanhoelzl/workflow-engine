## ADDED Requirements

### Requirement: Runtime hosts the action-dispatch plugin module

The runtime package SHALL host the action-dispatch plugin module at `packages/runtime/src/plugins/action-dispatch.ts`. The module SHALL export the plugin's `name`, `dependsOn`, `worker`, and `guest` symbols (consumed by the `?sandbox-plugin` vite query when composing the production plugin catalog). The plugin encapsulates all action-dispatch lifecycle logic. Runtime compositions SHALL include this plugin. (Detailed plugin behavior: see the "action-dispatch plugin shape" requirement below.)

The plugin module SHALL NOT live in the SDK package. The `@workflow-engine/sdk` package SHALL NOT declare `@workflow-engine/sandbox` as a dependency or as a TypeScript project reference.

#### Scenario: Plugin lives in the runtime package

- **GIVEN** the workspace
- **WHEN** the runtime imports `./plugins/action-dispatch.ts?sandbox-plugin` from `packages/runtime/src/sandbox-store.ts`
- **THEN** the resulting plugin descriptor's `name` SHALL be `"action-dispatch"`
- **AND** its `dependsOn` SHALL include `"host-call-action"`
- **AND** `packages/sdk/package.json` `dependencies` SHALL NOT contain `@workflow-engine/sandbox`
- **AND** `packages/sdk/package.json` `exports` SHALL NOT contain a `"./sdk-support"` (or `"./action-dispatch"`) entry
- **AND** `packages/sdk/tsconfig.json` `references` SHALL NOT contain `{ "path": "../sandbox" }`

### Requirement: action-dispatch plugin shape

The action-dispatch plugin module SHALL declare `dependsOn: ["host-call-action"]`, consuming both `validateAction` and `validateActionOutput` from the host-call-action plugin's exports.

The plugin SHALL register a private guest function descriptor `__sdkDispatchAction` with signature `(name: string, input: unknown, handler: Callable) => unknown`. The descriptor's `log` SHALL be `{ request: "action" }`, so the sandbox auto-wraps each call in an `action.request` / `action.response` / `action.error` frame. Within that wrap the handler SHALL:

1. Invoke `validateAction(name, input)` (via `deps["host-call-action"].validateAction`); on throw, the rejection propagates out of the auto-wrap and `action.error` fires.
2. Invoke the captured guest `handler(input)` callable; inspect the returned `CallableResult` envelope (per `sandbox/spec.md` "Guest→host boundary opacity (Callable envelope contract)"). When `result.ok === false`, the handler SHALL `throw result.error;` so that the underlying `GuestThrownError` flows back through the surrounding `buildHandler` closure rule's pass-through branch (per `sandbox/spec.md` "Host/sandbox boundary opacity for thrown errors") and reaches the calling guest VM as the action's throw with `.name`, `.message`, and structured own-properties intact. When `result.ok === true`, the handler SHALL bind `raw = result.value` and continue.
3. Invoke `validateActionOutput(name, raw)` on the host (via `deps["host-call-action"].validateActionOutput`) and return its validated result.
4. Dispose the captured `handler` in a `finally` block.

The handler SHALL NOT use a `try/catch` around `await handler(input)` to recover from guest throws; rejection-as-control-flow is no longer the surfacing mechanism for guest throws under the envelope contract. The `try/catch` previously needed for output validation translation (`translateValidatorThrow`) remains, applied only to the `validateActionOutput` call.

The dispatcher signature SHALL NOT accept a `completer` callable. Any extra positional argument passed by a stale guest SHALL be ignored; validation SHALL run host-side regardless. This keeps the security property intact even if a tenant bundle lags behind the new SDK shape (per `sandbox-output-validation`).

The plugin's `guest()` export (bundled as `descriptor.guestSource` by the vite plugin) SHALL install a locked `__sdk` object via `Object.defineProperty(globalThis, "__sdk", { value: Object.freeze({ dispatchAction: (name, input, handler) => raw(name, input, handler) }), writable: false, configurable: false, enumerable: false })` where `raw` is the captured `__sdkDispatchAction` private global. This is the canonical example of SECURITY.md §2 R-2 (locked host-callable global).

The guest-facing surface (`__sdk.dispatchAction`, the private `__sdkDispatchAction` descriptor name) is the SDK↔runtime ABI baked into emitted tenant bundles and SHALL remain stable across plugin renames or relocations.

#### Scenario: __sdk.dispatchAction is the guest surface

- **GIVEN** a sandbox with the `action-dispatch` plugin composed
- **WHEN** user source evaluates `typeof globalThis.__sdk.dispatchAction`
- **THEN** the result SHALL be `"function"`
- **AND** `typeof globalThis.__sdkDispatchAction` SHALL be `"undefined"`

#### Scenario: __sdk binding is locked

- **WHEN** user source evaluates `globalThis.__sdk = { dispatchAction: () => {} }`
- **THEN** the assignment SHALL throw in strict mode or silently no-op in sloppy mode
- **AND** `delete globalThis.__sdk` SHALL return false (non-configurable)

#### Scenario: __sdk object is frozen

- **GIVEN** the `__sdk` global as installed by action-dispatch
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

## MODIFIED Requirements

### Requirement: host-call-action plugin depends on none

The `host-call-action` plugin module SHALL declare `dependsOn: []` (or omit it). It provides validation capability to downstream plugins via `exports`; the `action-dispatch` plugin declares `dependsOn: ["host-call-action"]` and topo-sort guarantees host-call-action's `worker()` runs first.

#### Scenario: Plugin loads before action-dispatch

- **GIVEN** a composition containing both the `host-call-action` and `action-dispatch` plugins
- **WHEN** the sandbox is constructed
- **THEN** host-call-action's `worker()` SHALL run before action-dispatch's
- **AND** action-dispatch SHALL receive `validateAction` + `validateActionOutput` via `deps["host-call-action"]`
