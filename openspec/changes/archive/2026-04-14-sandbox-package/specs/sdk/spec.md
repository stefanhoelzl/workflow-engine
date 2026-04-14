## MODIFIED Requirements

### Requirement: ActionContext type in SDK

The SDK's `ActionContext` type SHALL include `event`, `env`, and a per-action narrowed `emit` method. It SHALL NOT include a `fetch` property.

The `emit` method SHALL be generic-narrowed based on the action's declared `emits` array and the workflow's declared event schemas:

```ts
interface ActionContext<Payload, Events, Env> {
  event: Event<Payload>;
  env: Readonly<Record<Env, string>>;
  emit: <K extends keyof Events & string>(
    type: K,
    payload: Events[K],
  ) => Promise<void>;
}
```

`ctx.emit` is injected onto ctx at runtime by a wrapper installed in the SDK's `workflow.action({...})` builder. The wrapper closes over the per-run `emit` global that the runtime installs via `Sandbox.run(name, ctx, extraMethods)`. The wrapper performs a lazy check: if `globalThis.emit` is not a function when `ctx.emit` is called, it throws `Error("emit is not installed; the runtime must register it as an extraMethod")`.

The SDK SHALL also declare an ambient global `emit` function as an escape hatch with a wider, untyped signature:

```ts
declare global {
  function emit(type: string, payload: unknown): Promise<void>;
}
```

The two paths coexist: `ctx.emit` is the narrow, type-checked path for action handlers; `emit` as a bare global is wider and available anywhere inside workflow source. Workflow authors SHOULD prefer `ctx.emit` for type safety.

Network access is provided by the global `fetch` function (a polyfill), not by a method on the context.

#### Scenario: ActionContext type has no fetch

- **GIVEN** a workflow action handler typed with the SDK's `ActionContext`
- **WHEN** the handler attempts to access `ctx.fetch`
- **THEN** TypeScript SHALL report a type error (property does not exist)

#### Scenario: ctx.emit accepts a declared event in the emits array

- **GIVEN** an action declared with `emits: ["order.parsed"]` and a corresponding event schema
- **WHEN** the handler calls `ctx.emit("order.parsed", { total: 42 })` with a matching payload
- **THEN** TypeScript SHALL accept the call

#### Scenario: ctx.emit rejects an event name not in emits

- **GIVEN** an action declared with `emits: ["order.parsed"]`
- **WHEN** the handler calls `ctx.emit("order.shipped", {})` where `order.shipped` is a defined event but not in emits
- **THEN** TypeScript SHALL report a type error on the event name argument

#### Scenario: ctx.emit rejects a wrong payload shape

- **GIVEN** an action declared with `emits: ["order.parsed"]` where `order.parsed` expects `{ total: number }`
- **WHEN** the handler calls `ctx.emit("order.parsed", { orderId: "abc" })`
- **THEN** TypeScript SHALL report a type error on the payload argument

#### Scenario: emit is also available as an ambient global

- **GIVEN** a workflow TypeScript file importing from `@workflow-engine/sdk`
- **WHEN** the file calls `emit("order.done", { id: 1 })` at the top level or inside an action handler
- **THEN** TypeScript SHALL resolve `emit` via the SDK's ambient declaration
- **AND** the return type SHALL be `Promise<void>`

#### Scenario: ActionContext type has event and env

- **GIVEN** a workflow action handler typed with the SDK's `ActionContext`
- **WHEN** the handler accesses `ctx.event` and `ctx.env`
- **THEN** both are properly typed and accessible

#### Scenario: ctx.emit throws when the runtime has not installed the emit global

- **GIVEN** a sandbox invoked via `Sandbox.run(name, ctx)` without an `emit` entry in `extraMethods`
- **WHEN** the wrapped handler calls `ctx.emit(...)`
- **THEN** the wrapper SHALL throw `Error("emit is not installed; the runtime must register it as an extraMethod")`
- **AND** the error SHALL surface as a failed `RunResult`
