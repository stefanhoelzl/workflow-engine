## REMOVED Requirements

### Requirement: Zod-based event definitions

**Reason**: The event primitive is removed entirely in v1. Workflows compose by direct function calls (action calls) rather than by emitting events that other actions subscribe to. Action input/output schemas at each `action({input, output})` declaration replace event-payload schemas.

**Migration**: For each `defineEvent('x', schema)` paired with an action consuming it, define `const x = action({ input: schema, output: ..., handler })`. Replace `ctx.emit('x', payload)` with `await x(payload)`.

### Requirement: Runtime payload validation

**Reason**: Without `emit()` there is nothing to validate at emit time. Action input/output validation at the bridge replaces it (see `payload-validation` capability).

**Migration**: Validation happens at the action call boundary, not at an emit boundary.

### Requirement: Rich event metadata

**Reason**: RuntimeEvent and its metadata fields (`id`, `correlationId`, `parentEventId`, `targetAction`, `state`, `sourceType`, `sourceName`, `result`, `error`) do not apply to the new model. Invocation lifecycle records have a much smaller field set (see `invocations` capability).

**Migration**: Consumers expecting RuntimeEvent metadata SHALL switch to invocation lifecycle event fields.

### Requirement: Fan-out dispatch

**Reason**: There is no fan-out at the wiring level. Multiple parallel side effects are expressed in code via `await Promise.all([...])` inside the calling handler.

**Migration**: Replace event fan-out with explicit parallel calls in handler code.

### Requirement: SDK Event type

**Reason**: There is no SDK `Event` type. Action handlers receive `(input)` directly; trigger handlers receive `(payload)`. Both are typed by the relevant Zod schema.

**Migration**: Replace `Event<P>` references with the input/payload type from the relevant Zod schema.

### Requirement: RuntimeEvent extends Event

**Reason**: RuntimeEvent does not exist in v1. Invocation lifecycle records replace it.

**Migration**: Use `InvocationLifecycleEvent` from the `invocations` and `event-bus` capabilities.

### Requirement: Five-state lifecycle model

**Reason**: The `pending → processing → done` state machine with `succeeded | failed | skipped` results is replaced by a simpler invocation lifecycle (`started → completed | failed`).

**Migration**: Map external systems that depended on the five-state model to the new invocation lifecycle (`pending` is the persistence state while in flight; `processing` is collapsed because the executor begins handler dispatch immediately; `skipped` no longer applies because there are no events to dispatch).
