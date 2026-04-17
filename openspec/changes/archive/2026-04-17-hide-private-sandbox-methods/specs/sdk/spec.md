## MODIFIED Requirements

### Requirement: action factory returns typed callable

The SDK SHALL export `action({ input, output, handler })` returning an `Action<I, O>` object that is BOTH branded with `ACTION_BRAND` AND callable as `(input: I) => Promise<O>`. The returned callable's body SHALL invoke the runtime-installed action dispatcher via the `dispatchAction()` helper exported from `@workflow-engine/core`; `dispatchAction()` SHALL read `globalThis.__dispatchAction` and invoke it with `(name, input, handler, outputSchema)`. The dispatcher (installed by the runtime and locked as non-writable, non-configurable — see `sandbox` capability) SHALL reach the host-side `__hostCallAction` bridge for input validation, invoke the handler in the same QuickJS context, validate the return value against the output schema, and emit `action.*` lifecycle events via the captured `__emitEvent` reference.

The action's `name` SHALL be assigned via the `__setActionName(exportName)` helper on the callable. `__setActionName` SHALL be write-once and same-name idempotent: calling it again with the same name SHALL be a no-op; calling it again with a different name SHALL throw. The binding SHALL be performed by the vite-plugin at build time (for manifest derivation on the Node-side Action instance) and separately by a runtime-appended binder shim at sandbox evaluation time (to name the VM-fresh closure that the SDK's `action()` factory creates when the bundle re-evaluates inside the QuickJS context). After the runtime binder shim has completed, the `__setActionName` property SHALL be deleted from each action callable to prevent guest code from rebinding.

The config SHALL require:
- `input`: `z.ZodType<I>` --- Zod schema validating action input
- `output`: `z.ZodType<O>` --- Zod schema validating action output
- `handler`: `(input: I) => Promise<O>` --- async handler function

#### Scenario: Action handle is callable and branded

- **GIVEN** `const send = action({ input, output, handler })`
- **WHEN** the value is inspected
- **THEN** `send` SHALL be a function (callable)
- **AND** `send[ACTION_BRAND]` SHALL be `true`
- **AND** `send.input`, `send.output`, `send.handler` SHALL be exposed

#### Scenario: TypeScript infers input/output from schemas

- **GIVEN** `const a = action({ input: z.object({ x: z.number() }), output: z.string(), handler: ... })`
- **WHEN** `await a({ x: 1 })` is called
- **THEN** TypeScript SHALL accept the call and infer the result as `Promise<string>`
- **AND** `await a({ x: "wrong" })` SHALL be a TypeScript compile-time error

#### Scenario: Callable dispatches via __dispatchAction

- **GIVEN** an action callable inside a sandbox where the runtime-appended dispatcher shim has installed `__dispatchAction`
- **WHEN** the callable is invoked with a valid input
- **THEN** the callable SHALL reach `globalThis.__dispatchAction(name, input, handler, outputSchema)` via `core.dispatchAction()`
- **AND** the dispatcher SHALL run input validation, invoke the handler, and validate the output before returning the validated result to the caller
