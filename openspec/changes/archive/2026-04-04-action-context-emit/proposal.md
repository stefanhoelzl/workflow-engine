## Why

Events are currently created ad-hoc in three places (trigger callback, dispatch action, and soon `ctx.emit()` in user actions), each manually assembling event fields. This makes it impossible to enforce consistent metadata (correlationId, parentEventId) and creates a maintenance burden as the Event interface grows. A unified context-based emit mechanism provides a single path for event creation across triggers and actions.

## What Changes

- Introduce a `Context` interface with an `emit(type, payload)` method as the sole mechanism for creating and enqueuing events
- Implement `HttpTriggerContext` (has request + trigger definition) and `ActionContext` (has event) both implementing `Context`
- Introduce a `ContextFactory` that holds the queue reference and exposes arrow properties `httpTrigger` and `action` to create the respective context objects
- **BREAKING**: Change action handler signature from `(event: Event) => void` to `(ctx: ActionContext) => Promise<void>` (async)
- **BREAKING**: Refactor dispatch to be a regular action using `ctx.emit()` instead of direct `queue.enqueue()` calls
- Add `correlationId` and `parentEventId` fields to the `Event` interface — root events (from triggers) generate a new `corr_`-prefixed correlationId; child events (from actions) inherit it and set parentEventId
- Update trigger middleware to receive `factory.httpTrigger` instead of a raw callback
- Update scheduler to receive `factory.action` and construct ActionContext for handlers
- Add integration test proving: trigger → action → emit → fan-out to 2 subscribers
- Update `main.ts` demo wiring for manual curl validation

## Capabilities

### New Capabilities

- `context`: Unified Context interface, HttpTriggerContext, ActionContext, and ContextFactory for event creation and enqueueing

### Modified Capabilities

- `events`: Add `correlationId` (prefixed `corr_`) and `parentEventId` to Event interface; drop `traceId` and `status` from the immediate scope
- `actions`: Handler signature changes from `(event: Event) => void` to `(ctx: ActionContext) => Promise<void>`; action handlers can now emit events
- `dispatch`: Dispatch uses `ctx.emit()` via ActionContext instead of direct queue access
- `triggers`: Trigger middleware uses `HttpTriggerContext.emit()` via ContextFactory instead of a raw callback
- `scheduler`: Scheduler receives a context factory function, constructs ActionContext, and awaits async handlers

## Impact

- **packages/runtime/src/actions/**: Action interface changes handler signature; dispatch.ts rewritten to use ctx.emit()
- **packages/runtime/src/event-queue/index.ts**: Event interface gains correlationId and parentEventId fields
- **packages/runtime/src/scheduler/index.ts**: Receives context factory, builds ActionContext, awaits async handlers
- **packages/runtime/src/triggers/http.ts**: Middleware accepts context factory instead of callback
- **packages/runtime/src/main.ts**: Wires ContextFactory, passes factory.httpTrigger and factory.action
- **All existing tests**: Must be updated for new handler signatures and context-based APIs
- No new external dependencies
- No manifest format changes
- No QueueStore interface changes (enqueue signature unchanged)
