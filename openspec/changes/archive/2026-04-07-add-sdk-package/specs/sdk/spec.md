## REMOVED Requirements

### Requirement: defineEvent helper
**Reason**: Replaced by inline Zod schemas in the `defineWorkflow` events map. Event type strings serve as both the key and the runtime identifier, eliminating the need for a separate `defineEvent` function.
**Migration**: Use `defineWorkflow({ events: { 'event.type': zodSchema } })` instead of `defineEvent('event.type', zodSchema)`.

### Requirement: Workflow DSL builder
**Reason**: Replaced by the `defineWorkflow` declarative object API. A single object literal provides better TypeScript inference for cross-references between events, triggers, and actions.
**Migration**: Use `defineWorkflow({ events, triggers, actions })` instead of `workflow().trigger().on()`.

### Requirement: httpTrigger factory
**Reason**: Replaced by inline trigger objects in the `defineWorkflow` triggers map with `type: 'http'`.
**Migration**: Use `triggers: { name: { type: 'http', path, event, response } }` inside `defineWorkflow`.

### Requirement: ActionContext type
**Reason**: Replaced by an internal `ActionContext` type within the SDK. `ctx.data` is replaced by `ctx.event` with `{ name, payload }` shape. `ctx.env` and `ctx.fetch()` are added. The type is inferred within `defineWorkflow` and not exported.
**Migration**: Use `defineWorkflow` — handler `ctx` type is inferred automatically.

### Requirement: SystemError event
**Reason**: Deferred to a future change. Not needed for the initial SDK implementation.
**Migration**: None — will be re-added as a built-in event definition in a future change.

### Requirement: No runtime footprint
**Reason**: In the Option D sandbox architecture, the SDK ships inside the workflow bundle and runs within the sandbox. The SDK is not erased during bundling; Zod schemas and the `defineWorkflow` function execute inside the isolate.
**Migration**: None — this is an architectural change, not an API change.
