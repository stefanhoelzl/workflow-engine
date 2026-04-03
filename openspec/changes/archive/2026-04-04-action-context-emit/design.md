## Context

The runtime currently has a working event pipeline: HTTP trigger → event queue → scheduler → dispatch → action. However, event creation is scattered across three call sites (trigger callback in main.ts, dispatch action, and the upcoming ctx.emit() in user actions), each manually constructing Event objects with ad-hoc field assembly.

The action handler signature is `(event: Event) => void` — actions cannot emit new events, so workflows cannot chain (action A → event → action B). This is the primary gap blocking a minimal working example of the full event cycle.

Current event creation sites:
- **Trigger callback** (main.ts:42-48): constructs `{ id, type, payload, createdAt }`, calls `queue.enqueue()`
- **Dispatch action** (dispatch.ts:16-20): spreads parent event, overrides `id` and `targetAction`, calls `queue.enqueue()`

Both bypass any centralized event construction, making it impossible to enforce consistent metadata like correlationId.

## Goals / Non-Goals

**Goals:**
- Single mechanism for event creation and enqueueing used by both triggers and actions
- Action handlers can emit new events that flow through the same dispatch pipeline
- Event lineage tracking via correlationId (inherited) and parentEventId (causal chain)
- Dispatch refactored to use the same context mechanism as user actions
- Integration test proving: trigger → action → emit → fan-out to 2 subscribers
- Updated main.ts for manual curl validation

**Non-Goals:**
- traceId field (deferred — no practical distinction from correlationId yet)
- status field on Event (deferred)
- system.error event emission on action failure
- Zod-based typed events or SDK DSL
- Sandbox/isolate execution
- Concurrent scheduler processing
- Filesystem-backed queue

## Decisions

### Decision 1: Context interface hierarchy

Introduce a `Context` interface with a single `emit(type, payload)` method. Two implementations:
- `HttpTriggerContext` — carries the parsed request body and trigger definition
- `ActionContext` — carries the source event

**Why not a single context type?** Triggers and actions have fundamentally different input data (HTTP request vs event). Separate types give precise typing for each handler. The shared `Context` interface ensures the emit mechanism is uniform.

**Why not pass emit as a second argument?** `(event, emit)` diverges from the planned SDK API where `ctx.data` and `ctx.emit()` live on the same object. Starting with the context pattern avoids a future migration.

### Decision 2: ContextFactory with arrow properties

A `ContextFactory` class holds the queue reference and exposes two arrow properties:
- `httpTrigger(request, definition) → HttpTriggerContext`
- `action(event) → ActionContext`

Arrow properties (class fields assigned as arrow functions) capture `this` lexically, allowing `factory.httpTrigger` and `factory.action` to be passed directly as arguments in main.ts without binding issues.

**Wiring in main.ts:**
```
const factory = new ContextFactory(queue)
httpTriggerMiddleware(registry, factory.httpTrigger)
new Scheduler(queue, actions, factory.action)
```

**Why a class, not standalone functions?** Both factory methods need the queue reference. A class avoids passing the queue to each call site and provides a natural home for the shared `#createAndEnqueue()` logic.

**Alternative considered: methods on EventQueue.** Rejected because event creation (generating ids, metadata, lineage) is a separate concern from queue storage. The queue interface should stay focused on enqueue/dequeue/ack/fail.

### Decision 3: emit() goes through the full pipeline

`ctx.emit(type, payload)` enqueues a new event with `targetAction: undefined`. The scheduler picks it up, dispatch fans it out to subscribers. This reuses existing infrastructure:

```
Action handler
  │ ctx.emit("order.validated", data)
  ▼
ContextFactory.#createAndEnqueue()
  │ creates Event { id, type, payload, correlationId, parentEventId, createdAt }
  │ targetAction = undefined
  ▼
queue.enqueue()
  ▼
Scheduler dequeues → dispatch matches → fan-out to subscribers
```

**Why not let actions target specific actions directly?** That would bypass dispatch and break the uniform fan-out model. Actions shouldn't know about other actions — they emit events, and the wiring determines who receives them.

### Decision 4: correlationId and parentEventId lineage

Root events (from triggers): `correlationId = corr_<uuid>`, `parentEventId = undefined`.
Child events (from ctx.emit in actions): inherit `correlationId` from source event, `parentEventId = source event id`.
Dispatch fan-out events: inherit both from the source event (dispatch is just an action using ctx.emit).

The ContextFactory's internal `#createAndEnqueue()` method takes an optional parent event. If present, it inherits correlationId and sets parentEventId. If absent, it generates a new correlationId.

### Decision 5: Async action handlers

Handler signature changes from `(event: Event) => void` to `(ctx: ActionContext) => Promise<void>`. The scheduler awaits handler execution. This is necessary because `ctx.emit()` calls `queue.enqueue()` which returns a Promise.

### Decision 6: Scheduler receives context factory function

The scheduler constructor receives a function `(event: Event) => ActionContext` instead of knowing about ContextFactory. This keeps the scheduler decoupled — in tests, you can pass a stub function.

```
                  ┌─────────────────────────┐
                  │     ContextFactory       │
                  │                          │
                  │  httpTrigger ──────────────────▶ HttpTriggerContext
                  │     (request, def)       │
                  │                          │
                  │  action ─────────────────────▶ ActionContext
                  │     (event)              │
                  │                          │
                  │  #createAndEnqueue() ◄───│── shared internal
                  │     (type, payload,      │
                  │      parent?)            │
                  └───────────┬─────────────┘
                              │
                              ▼
                  ┌─────────────────────────┐
                  │     EventQueue           │
                  │     .enqueue()           │
                  └─────────────────────────┘
```

### Decision 7: Trigger middleware signature change

`httpTriggerMiddleware` currently takes `(registry, callback)` where callback is `(definition, body) => void`. This changes to accept a function that creates an HttpTriggerContext:

```
httpTriggerMiddleware(registry, factory.httpTrigger)
```

The middleware calls `factory.httpTrigger(body, definition)`, then calls `ctx.emit(definition.event, body)` to create and enqueue the event. The trigger's static response is returned as before.

## Risks / Trade-offs

**[Risk] Dispatch fan-out events lose lineage context** — When dispatch creates targeted events, it's using ctx.emit() which sets parentEventId to the dispatch event's id, not the original trigger event. This means the fan-out events point to the dispatch event as parent, not the original.
→ This is actually correct: the causal chain is trigger → dispatch → targeted action. The correlationId links them all to the same workflow run.

**[Risk] Async handler adds latency to scheduler loop** — The scheduler now awaits each handler. If an action emits many events, each enqueue is awaited sequentially within the handler.
→ Acceptable for the MWE. The scheduler already processes events sequentially. Concurrent processing is a future concern.

**[Risk] Breaking change to Action interface** — All existing tests and the integration test must be updated.
→ Small codebase, all tests are in-repo. Straightforward update.
