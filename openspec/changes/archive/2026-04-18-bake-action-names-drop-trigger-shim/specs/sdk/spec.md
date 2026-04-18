## MODIFIED Requirements

### Requirement: action factory returns typed callable

The SDK SHALL export `action({ input, output, handler, name })` returning an `Action<I, O>` object that is BOTH branded with `ACTION_BRAND` AND callable as `(input: I) => Promise<O>`. The `name` field SHALL be a required `string` carrying the action's identity (used for dispatcher routing, host-side input validation, and audit logging). The returned callable's body SHALL invoke the runtime-installed action dispatcher via the `dispatchAction()` helper exported from `@workflow-engine/core`; `dispatchAction()` SHALL read `globalThis.__dispatchAction` and invoke it with `(name, input, handler, outputSchema)`. The dispatcher (installed by the runtime and locked as non-writable, non-configurable — see `sandbox` capability) SHALL reach the host-side `__hostCallAction` bridge for input validation, invoke the handler in the same QuickJS context, validate the return value against the output schema, and emit `action.*` lifecycle events via the captured `__emitEvent` reference.

The captured `handler` reference SHALL NOT be exposed as a public property on the returned `Action` value — the only path to invoke the handler SHALL be through the callable itself, which routes through the dispatcher. Guest code SHALL NOT be able to call the handler directly to bypass `__hostCallAction` audit logging.

The vite-plugin SHALL inject `name` into each `action({...})` call expression at build time (see `vite-plugin` capability). When `action({...})` is constructed without a `name` (e.g., in a hand-rolled bundle that did not go through the plugin), the callable SHALL throw `"Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/plugin"` on first invocation.

The config SHALL require:
- `input`: `z.ZodType<I>` --- Zod schema validating action input
- `output`: `z.ZodType<O>` --- Zod schema validating action output
- `handler`: `(input: I) => Promise<O>` --- async handler function
- `name`: `string` --- the action's identity (typically injected by the vite-plugin)

#### Scenario: Action handle is callable and branded

- **GIVEN** `const send = action({ input, output, handler, name: "send" })`
- **WHEN** the value is inspected
- **THEN** `send` SHALL be a function (callable)
- **AND** `send[ACTION_BRAND]` SHALL be `true`
- **AND** `send.input`, `send.output`, `send.name` SHALL be exposed as readonly properties
- **AND** `send.handler` SHALL NOT be defined as an own property

#### Scenario: TypeScript infers input/output from schemas

- **GIVEN** `const a = action({ input: z.object({ x: z.number() }), output: z.string(), handler: ..., name: "a" })`
- **WHEN** `await a({ x: 1 })` is called
- **THEN** TypeScript SHALL accept the call and infer the result as `Promise<string>`
- **AND** `await a({ x: "wrong" })` SHALL be a TypeScript compile-time error

#### Scenario: Callable dispatches via __dispatchAction

- **GIVEN** an action callable inside a sandbox where the runtime-appended dispatcher shim has installed `__dispatchAction`
- **WHEN** the callable is invoked with a valid input
- **THEN** the callable SHALL reach `globalThis.__dispatchAction(name, input, handler, outputSchema)` via `core.dispatchAction()`
- **AND** the dispatcher SHALL run input validation, invoke the handler, and validate the output before returning the validated result to the caller

#### Scenario: Action constructed without a name throws on invocation

- **GIVEN** a hand-rolled call `const orphan = action({ input, output, handler })` with no `name` field
- **WHEN** `await orphan({...})` is called
- **THEN** the call SHALL throw with message "Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/plugin"
