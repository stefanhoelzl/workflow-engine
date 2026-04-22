## ADDED Requirements

### Requirement: SDK exports createSdkSupportPlugin

The SDK package (`@workflow-engine/sdk`) SHALL export a `createSdkSupportPlugin(): Plugin` factory alongside its guest-facing exports. The plugin encapsulates all action-dispatch lifecycle logic (previously in runtime's appended `action-dispatcher.js` source). Runtime compositions SHALL include this plugin. (Detailed plugin behavior: see sandbox-sdk-plugin capability.)

#### Scenario: SDK package exports the plugin factory

- **GIVEN** the `@workflow-engine/sdk` package
- **WHEN** consumers import from it
- **THEN** `createSdkSupportPlugin` SHALL be a named export
- **AND** invoking it SHALL return a `Plugin` whose name is `"sdk-support"` and whose `dependsOn` includes `"host-call-action"`

## MODIFIED Requirements

### Requirement: action factory returns typed callable

The `action(config)` export from the SDK SHALL produce a callable that, when invoked with input, calls `globalThis.__sdk.dispatchAction(config.name, input, config.handler, (raw) => config.outputSchema.parse(raw))`. The callable SHALL return the result of that call. The SDK SHALL NOT contain any direct bridge logic, event emission, schema parsing, or lifecycle emission — all of that lives in the sdk-support plugin's host-side handler.

```ts
// SDK implementation:
export const action = (config) => async (input) =>
  globalThis.__sdk.dispatchAction(
    config.name,
    input,
    config.handler,
    (raw) => config.outputSchema.parse(raw),
  );
```

The `handler` and `outputSchema.parse` callbacks SHALL be captured by the sdk-support plugin as `Callable` values (via `Guest.callable()`), invoked worker-side, and disposed after each dispatch.

#### Scenario: action() calls __sdk.dispatchAction

- **GIVEN** `action({ name: "myAction", handler: async (input) => input, outputSchema: z.object({ foo: z.string() }) })`
- **WHEN** the callable is invoked with `{ foo: "bar" }`
- **THEN** `globalThis.__sdk.dispatchAction("myAction", { foo: "bar" }, handler, completer)` SHALL be called
- **AND** the SDK-bundled callable SHALL return the resolved result from `__sdk.dispatchAction`

#### Scenario: SDK contains no direct event emission

- **GIVEN** the SDK source
- **WHEN** audited for calls to `__emitEvent`, `__hostCallAction`, or any bridge global
- **THEN** no such calls SHALL exist (all have been replaced by the indirection through `__sdk.dispatchAction`)

