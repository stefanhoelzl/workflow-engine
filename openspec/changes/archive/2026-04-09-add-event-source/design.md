## Context

Events in the workflow engine carry rich metadata (`id`, `correlationId`, `parentEventId`, `targetAction`, `state`, `result`) but no explicit indication of who emitted them. Determining whether an event originated from a trigger or an action requires walking `parentEventId` chains. The SDK's `workflow().trigger(name, config)` accepts a name argument but currently discards it (`_name`), so trigger names are unavailable at runtime.

## Goals / Non-Goals

**Goals:**
- Make event origin immediately visible on every `RuntimeEvent` via `sourceType` and `sourceName` fields
- Thread trigger names from the SDK builder through `WorkflowConfig` → `HttpTriggerResolved` → event creation
- Maintain the existing spread-based state transition pattern in the scheduler

**Non-Goals:**
- Routing logic based on source — these fields are observability-only
- Backwards-compatible recovery of persisted events missing `sourceType`/`sourceName`
- Exposing source fields to sandboxed action handlers (no change to SDK `ActionContext`)

## Decisions

### Flat fields over nested object

`sourceType: 'trigger' | 'action'` and `sourceName: string` as top-level fields on `RuntimeEvent`, rather than a nested `source: { type, name }` object.

**Rationale:** Consistent with existing flat field style (`correlationId`, `parentEventId`, `targetAction`). Maps directly to DuckDB columns without JSON extraction. Simplifies spread-based state transitions.

**Alternative considered:** Nested `source` object — rejected because it adds a nesting level inconsistent with the rest of the event model and complicates DuckDB queries.

### Factory infers sourceType from method

`EventFactory.create(type, payload, correlationId, source)` sets `sourceType: 'trigger'`. `EventFactory.derive(parent, type, payload, source)` sets `sourceType: 'action'`. The `source` parameter is just the name string.

**Rationale:** The factory method already encodes the semantic distinction (create = trigger origin, derive = action origin). Passing the full `{ type, name }` would be redundant.

**Alternative considered:** Passing `{ type, name }` — rejected as redundant given the method already implies the type.

### Fork inherits source from parent

`EventFactory.fork(parent, { targetAction })` copies `sourceType` and `sourceName` from the parent event. No additional parameter needed.

**Rationale:** Fan-out forks are routing copies of the original event. The emitter is still whoever originally emitted the event being fanned out. The scheduler is not an "emitter" in the domain sense.

### No backwards compatibility for persisted events

`sourceType` and `sourceName` are required fields with no Zod defaults. Existing persisted events without these fields will fail Zod parsing on recovery.

**Rationale:** This is a breaking change accepted by the project. No production persistence stores need migration.

## Data Flow

```
HTTP Request → httpTriggerMiddleware
                    │
                    ▼
              ContextFactory.httpTrigger(body, definition)
                    │  definition.name = "my-webhook"
                    ▼
              EventFactory.create(type, payload, correlationId, "my-webhook")
                    │  sourceType: "trigger", sourceName: "my-webhook"
                    ▼
              ┌─────────────────────────────────────┐
              │ RuntimeEvent (pending)               │
              │   sourceType: "trigger"              │
              │   sourceName: "my-webhook"           │
              └──────────────┬──────────────────────┘
                             │
                   ┌─────────┴─────────┐
                   ▼                   ▼
             Scheduler             Scheduler
             fanOut()              direct dispatch
                   │                   │
                   ▼                   ▼
             fork(parent, ...)    executeAction()
             inherits source          │
                                      ▼
                                action calls ctx.emit()
                                      │
                                      ▼
                                EventFactory.derive(event, type, payload, "send-email")
                                      │  sourceType: "action", sourceName: "send-email"
                                      ▼
                                ┌─────────────────────────────────────┐
                                │ RuntimeEvent (pending)               │
                                │   sourceType: "action"               │
                                │   sourceName: "send-email"           │
                                └─────────────────────────────────────┘
```

## Risks / Trade-offs

**[Breaking persisted events]** → Accepted. No Zod defaults. Existing persistence files without `sourceType`/`sourceName` will fail recovery. This is intentional — no production data needs migration.

**[Wide test surface]** → 6 test files with `makeEvent()` helpers need updating. Mechanical change but touches many files. Mitigated by the fact that each helper just needs two extra fields in its default object.
