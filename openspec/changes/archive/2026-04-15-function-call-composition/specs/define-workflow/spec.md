## REMOVED Requirements

### Requirement: createWorkflow factory

**Reason**: `createWorkflow(name)` and its phased builder (`.event().trigger().action().compile()`) are replaced by the declarative `defineWorkflow({name?, env?})` factory plus branded `action(...)` and `httpTrigger(...)` exports. The phased builder was needed to enforce event-then-action ordering at the type level; events are removed in v1, so the phasing has no purpose.

**Migration**: Replace `const w = createWorkflow("name").event(...).action(...);` with one workflow per file using `export const workflow = defineWorkflow({ name: "name" });` plus branded `action({...})` and `httpTrigger({...})` exports. See the SDK capability spec for details.

### Requirement: Phased builder enforces event-before-action ordering

**Reason**: The phasing (TriggerPhase → EventPhase → ActionPhase) only existed to make TS reject `.action()` calls referencing events that hadn't yet been declared on the builder. With events removed, there's nothing to order.

**Migration**: Declarations in the workflow file may appear in any order; TypeScript checks references directly because actions are typed callable references rather than string-keyed.

### Requirement: Workflow.env() builder method

**Reason**: Workflow-level env is now declared inline in `defineWorkflow({ env: {...} })` rather than via a chained `.env(...)` builder method.

**Migration**: Move env declarations into the `defineWorkflow` config object.
