## REMOVED Requirements

### Requirement: SDK exposes the sdk-support plugin module

**Reason**: The plugin has been relocated to the runtime package and renamed `action-dispatch`. The SDK no longer exposes any sandbox plugin module. This requirement is replaced by the `actions` capability's "Runtime hosts the action-dispatch plugin module" requirement.

**Migration**: Code that previously imported `@workflow-engine/sdk/sdk-support?sandbox-plugin` SHALL import from `packages/runtime/src/plugins/action-dispatch.ts?sandbox-plugin` instead. The only such consumer is `packages/runtime/src/sandbox-store.ts`. No author-facing migration is required (workflow author code never imported this entry point).

### Requirement: sdk-support plugin shape

**Reason**: Plugin behavior is unchanged but the plugin's home and name are. The behavioral spec lives in the `actions` capability under "action-dispatch plugin shape" after this change.

**Migration**: See `actions/spec.md` "action-dispatch plugin shape" for the full requirement text. The plugin's `dependsOn`, descriptor signature, handler steps, locked `__sdk` global installation, and stale-guest tolerance are byte-identical; only the plugin's `name` field changes from `"sdk-support"` to `"action-dispatch"` and the file moves from `packages/sdk/src/sdk-support/index.ts` to `packages/runtime/src/plugins/action-dispatch.ts`.

## MODIFIED Requirements

### Requirement: SDK provides subpath exports

The SDK package SHALL expose three entry points via the `exports` field in `package.json`:
- `"."` — DSL (defineWorkflow, action, httpTrigger, env, z, brands, type guards)
- `"./plugin"` — Vite plugin (`workflowPlugin` factory)
- `"./cli"` — Programmatic API (`build`, `upload`, `NoWorkflowsFoundError`)

The SDK SHALL NOT expose any sandbox plugin module via a subpath export. The runtime composes the sandbox plugin catalog from its own package; the SDK's role is workflow-author-facing only.

#### Scenario: Import DSL from root

- **WHEN** a module imports `{ defineWorkflow, z } from "@workflow-engine/sdk"`
- **THEN** it receives the workflow authoring DSL and Zod namespace

#### Scenario: Import plugin from subpath

- **WHEN** a module imports `{ workflowPlugin } from "@workflow-engine/sdk/plugin"`
- **THEN** it receives the Vite plugin factory function

#### Scenario: Import CLI API from subpath

- **WHEN** a module imports `{ build, upload } from "@workflow-engine/sdk/cli"`
- **THEN** it receives the programmatic build and upload functions

#### Scenario: SDK does not expose sandbox plugins

- **GIVEN** the `@workflow-engine/sdk` package
- **WHEN** a consumer attempts to resolve any sandbox-plugin subpath under `@workflow-engine/sdk`
- **THEN** package resolution SHALL fail (no matching `exports` entry)

### Requirement: action factory returns typed callable

The `action(config)` export from the SDK SHALL produce a callable that, when invoked with input, calls `globalThis.__sdk.dispatchAction(config.name, input, config.handler)`. The callable SHALL return the result of that call. The SDK SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the action-dispatch plugin via the host-call-action plugin's `validateActionOutput` export (per `sandbox-output-validation`). The SDK SHALL NOT contain any direct bridge logic, event emission, schema parsing, or lifecycle emission — all of that lives in the action-dispatch plugin's host-side handler and in the host-call-action plugin's schema validators.

```ts
// SDK implementation:
export const action = (config) => async (input) =>
  globalThis.__sdk.dispatchAction(
    config.name,
    input,
    config.handler,
  );
```

The `handler` callback SHALL be captured by the action-dispatch plugin as a `Callable` value (via `Guest.callable()`), invoked worker-side, and disposed in the plugin handler's `finally` block after each dispatch. The `config.outputSchema` object SHALL NOT cross the sandbox boundary at dispatch time — schema validators were rehydrated host-side at sandbox-construction time from the manifest's `outputSchema` entries (see `actions` "host-call-action plugin module").

Any extra positional argument that a stale tenant bundle passes as a fourth argument (legacy `(raw) => outputSchema.parse(raw)` completer) SHALL be silently ignored by the action-dispatch plugin handler; host-side validation runs regardless (per `sandbox-output-validation` stale-guest tolerance).

#### Scenario: action() calls __sdk.dispatchAction with three arguments

- **GIVEN** `action({ name: "myAction", handler: async (input) => input, outputSchema: z.object({ foo: z.string() }) })`
- **WHEN** the callable is invoked with `{ foo: "bar" }`
- **THEN** `globalThis.__sdk.dispatchAction("myAction", { foo: "bar" }, handler)` SHALL be called
- **AND** the SDK-bundled callable SHALL NOT pass a fourth positional argument
- **AND** the returned value SHALL be the resolved result from `__sdk.dispatchAction`

#### Scenario: SDK contains no direct event emission or legacy bridge references

- **GIVEN** the SDK source under `packages/sdk/src/`
- **WHEN** audited for calls to `__emitEvent`, `__hostCallAction`, or any other pre-plugin-architecture bridge global
- **THEN** no such call SHALL be found
- **AND** the SDK SHALL contain no imports from `@workflow-engine/sandbox`

### Requirement: action() SDK export is a passthrough

The SDK's `action()` factory SHALL produce callables whose implementation is a thin wrapper calling `globalThis.__sdk.dispatchAction(name, input, handler)`. The wrapper SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the `action-dispatch` plugin via the host-call-action plugin's `validateActionOutput` export. The SDK SHALL NOT reach into any other sandbox internals; all action-lifecycle logic lives in the `action-dispatch` plugin's worker-side handler.

#### Scenario: action() wraps dispatchAction

- **GIVEN** `action({ name: "myAction", input: z.object(...), output: z.object(...), handler: async (input) => input })`
- **WHEN** the callable is invoked with `await myAction({foo: "bar"})`
- **THEN** it SHALL call `globalThis.__sdk.dispatchAction("myAction", {foo: "bar"}, handler)`
- **AND** return the result
- **AND** it SHALL NOT pass any fourth positional argument

### Requirement: No runtime-appended dispatcher source

The runtime SHALL NOT append `action-dispatcher.js` (or any other dispatcher source) to tenant workflow bundles. All action-dispatcher logic lives in the runtime's `action-dispatch` plugin module (at `packages/runtime/src/plugins/action-dispatch.ts`, consumed via the `?sandbox-plugin` vite query). This is cross-referenced from `workflow-registry` (Sandbox loading) and `sandbox` (plugin composition) for runtime enforcement.

#### Scenario: Bundle loaded without source appending

- **GIVEN** a tenant workflow bundle produced by the vite plugin
- **WHEN** the runtime constructs the sandbox
- **THEN** `sandbox({source: <bundle>, plugins: [...]})` SHALL be invoked with `source` unchanged
- **AND** no dispatcher source SHALL be concatenated, prepended, or appended
