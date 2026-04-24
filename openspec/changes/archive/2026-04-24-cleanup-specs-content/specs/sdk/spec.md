## MODIFIED Requirements

### Requirement: action factory returns typed callable

The `action(config)` export from the SDK SHALL produce a callable that, when invoked with input, calls `globalThis.__sdk.dispatchAction(config.name, input, config.handler)`. The callable SHALL return the result of that call. The SDK SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the sdk-support plugin via the host-call-action plugin's `validateActionOutput` export (per `sandbox-output-validation`). The SDK SHALL NOT contain any direct bridge logic, event emission, schema parsing, or lifecycle emission — all of that lives in the sdk-support plugin's host-side handler and in the host-call-action plugin's Ajv validators.

```ts
// SDK implementation:
export const action = (config) => async (input) =>
  globalThis.__sdk.dispatchAction(
    config.name,
    input,
    config.handler,
  );
```

The `handler` callback SHALL be captured by the sdk-support plugin as a `Callable` value (via `Guest.callable()`), invoked worker-side, and disposed in the plugin handler's `finally` block after each dispatch. The `config.outputSchema` object SHALL NOT cross the sandbox boundary at dispatch time — Ajv validators were compiled host-side at sandbox-construction time from the manifest's `outputSchema` entries (see `actions` "createHostCallActionPlugin factory").

Any extra positional argument that a stale tenant bundle passes as a fourth argument (legacy `(raw) => outputSchema.parse(raw)` completer) SHALL be silently ignored by the sdk-support plugin handler; host-side validation runs regardless (per `sandbox-output-validation` stale-guest tolerance).

#### Scenario: action() calls __sdk.dispatchAction with three arguments

- **GIVEN** `action({ name: "myAction", handler: async (input) => input, outputSchema: z.object({ foo: z.string() }) })`
- **WHEN** the callable is invoked with `{ foo: "bar" }`
- **THEN** `globalThis.__sdk.dispatchAction("myAction", { foo: "bar" }, handler)` SHALL be called
- **AND** the SDK-bundled callable SHALL NOT pass a fourth positional argument
- **AND** the returned value SHALL be the resolved result from `__sdk.dispatchAction`

#### Scenario: SDK contains no direct event emission or legacy bridge references

- **GIVEN** the SDK source under `packages/sdk/src/`
- **WHEN** audited for calls to `__emitEvent`, `__hostCallAction`, or any other pre-plugin-architecture bridge global
- **THEN** no such calls SHALL exist

#### Scenario: outputSchema.parse is never constructed at dispatch time

- **GIVEN** the SDK source
- **WHEN** audited for closures of the shape `(raw) => outputSchema.parse(raw)` inside action callable construction
- **THEN** no such closure SHALL be constructed — output validation is host-side via the host-call-action plugin
