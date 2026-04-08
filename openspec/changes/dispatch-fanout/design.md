## Context

The runtime processes events through a pipeline: triggers emit undirected events, a dispatch action fans them out to subscriber actions, and the scheduler executes handlers. The dispatch action is currently modeled as a regular action but has special-cased behavior — it matches `targetAction === undefined`, uses synthetic events to discover subscribers, and skips itself in its own loop. This creates a leaky abstraction where infrastructure routing logic masquerades as user-defined business logic.

Event construction is currently owned entirely by `ContextFactory.#createAndEmit`, which handles validation, ID generation, metadata propagation, and bus emission. Both triggers and actions use this path, but the dispatch action's fan-out creates copies that re-validate already-validated payloads unnecessarily.

## Goals / Non-Goals

**Goals:**
- Move fan-out from a special action into the scheduler where it belongs
- Replace the opaque `match` predicate with a declarative `on` field on the Action interface
- Extract event construction into a dedicated `EventFactory` with distinct methods for each creation mode
- Maintain independent retry/failure semantics per action (each gets its own event)
- Maintain audit trail (fan-out copies link to original via `parentEventId`)

**Non-Goals:**
- Changing the EventBus or WorkQueue architecture
- Modifying the SDK's workflow builder API
- Adding payload-based routing (match on content, not just type)
- Concurrent fan-out — sequential emission is fine for now

## Decisions

### 1. Fan-out lives in the scheduler

The scheduler already dequeues events, matches them to actions, and manages lifecycle state transitions. Fan-out is a routing decision — determining which actions should process an event — which is the scheduler's core responsibility.

**Alternative considered:** Fan-out at emit time (triggers/actions resolve targets eagerly). Rejected because it couples emitters to action registration knowledge and complicates the emit API.

### 2. Action interface uses declarative `on` field

Replace `match: (event: RuntimeEvent) => boolean` with `on: string`. The scheduler performs routing:
- Undirected events: `actions.filter(a => a.on === event.type)`
- Directed events: `actions.find(a => a.name === event.targetAction && a.on === event.type)`

**Alternative considered:** Keep `match` predicate alongside `on`. Rejected because `match` becomes redundant — the scheduler has all information it needs from `name` + `on`.

### 3. EventFactory with three methods

```
EventFactory
  create(type, payload, correlationId)     → validates, new chain origin
  derive(parent, type, payload)            → validates, continues chain
  fork(parent, { targetAction })           → no validation, copies for fan-out
```

Each method captures distinct semantics:
- `create`: unknown data enters the system (triggers)
- `derive`: new event type/payload in an existing chain (action emit)
- `fork`: same event, different routing target (scheduler fan-out)

`fork` skips validation because `parent.payload` was already validated when the parent event was created. `create` and `derive` always validate because they accept `unknown` payloads.

**Alternative considered:** Single `create` method with optional validation flag. Rejected because the three methods make intent explicit at call sites and eliminate the possibility of accidentally skipping validation on untrusted input.

### 4. Fan-out state transitions

```
Undirected event dequeued:
  → emit(processing)
  → find matching actions by event.type
  → for each: bus.emit(fork(original, { targetAction }))
  → emit(done) if matches > 0, emit(skipped) if matches === 0
```

The original event transitions to `done` because its purpose (triggering fan-out) was fulfilled. `skipped` for zero matches aligns with the existing "no match" semantics.

### 5. ContextFactory delegates to EventFactory

`ContextFactory` keeps its role as the factory for `HttpTriggerContext` and `ActionContext`, but delegates event construction to `EventFactory`:
- `httpTrigger.emit()` → `eventFactory.create()` + `bus.emit()`
- `action.emit()` → `eventFactory.derive()` + `bus.emit()`

Logging stays in `ContextFactory` since it has the Logger dependency and contextual information.

### Sequence: Undirected event fan-out

```
HTTP Request
    │
    ▼
HttpTrigger ──eventFactory.create()──▶ bus.emit(pending)
                                          │
                              ┌───────────┤
                              ▼           ▼
                          WorkQueue   Persistence
                              │
                              ▼
                        Scheduler dequeues
                              │
                    targetAction === undefined
                              │
                      bus.emit(processing)
                              │
                    actions.filter(a.on === type)
                              │
                   ┌──────────┼──────────┐
                   ▼          ▼          ▼
              fork(e,{A})  fork(e,{B})  fork(e,{C})
                   │          │          │
              bus.emit    bus.emit    bus.emit
              (pending)   (pending)   (pending)
                              │
                      bus.emit(done)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        Scheduler         Scheduler       Scheduler
        dequeues A        dequeues B      dequeues C
              │               │               │
        execute handler  execute handler  execute handler
```

### Sequence: Directed event execution

```
Scheduler dequeues event (targetAction = "sendEmail")
    │
    ▼
bus.emit(processing)
    │
    ▼
find action: name === "sendEmail" && on === event.type
    │
    ▼
createContext(event) → action.handler(ctx)
    │
    ├── success → bus.emit(done)
    └── failure → bus.emit(failed, error)
```

## Risks / Trade-offs

- **[Partial fan-out on crash]** If the scheduler emits 2 of 3 fork copies and then crashes, recovery replays the original event (still in `processing` state) and re-fans-out, creating duplicate copies for the first 2 actions. → This is the same risk the current dispatch action has. Acceptable for now; idempotent actions mitigate impact.

- **[Two event construction paths]** `EventFactory` is used by both `ContextFactory` (for trigger/action emits) and the scheduler (for fan-out). This is intentional — the factory centralizes construction, and the distinct methods make the two paths explicit.

- **[Sequential fan-out]** Fan-out emits copies sequentially. For workflows with many subscribers to a single event type, this adds latency proportional to subscriber count. → Acceptable for current scale. Parallel emission can be added later if needed.
