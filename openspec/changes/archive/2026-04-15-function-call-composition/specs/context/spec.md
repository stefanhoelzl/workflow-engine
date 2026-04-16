## REMOVED Requirements

### Requirement: ActionContext

**Reason**: The `ctx` parameter is removed entirely. Action handlers receive `(input)` directly; trigger handlers receive `(payload)` directly. Workflow-level env is exposed as `workflow.env` on the module-scoped `Workflow` object, accessed via the imported `workflow` symbol from `defineWorkflow({...})`.

**Migration**: Replace `handler: async (ctx) => { ctx.event.payload; ctx.env.X; ctx.emit(...) }` with `handler: async (input) => { input; workflow.env.X; await otherAction(...) }`. Remove `ctx` from all handler signatures.

### Requirement: HttpTriggerContext

**Reason**: There is no separate trigger context. The trigger handler receives only `(payload)` and returns the response object directly.

**Migration**: Replace any `HttpTriggerContext.emit()` calls with handler return values that the executor uses as the HTTP response.
