## Context

The runtime currently accepts HTTP requests via triggers and enqueues events into an `InMemoryEventQueue`. Nothing dequeues or processes these events. The `Event` type has `id`, `type`, `payload`, and `createdAt` — but no notion of which action should handle it.

The specs describe a full pipeline (Trigger → Event → Action → Event) with fan-out dispatch, but the scheduler, action system, and dispatch mechanism are not yet implemented.

## Goals / Non-Goals

**Goals:**

- Complete the in-memory event processing pipeline: dequeue, match, execute, ack/fail
- Introduce the `Action` type with function-based matching
- Implement fan-out as a built-in dispatch action that goes through the same queue lifecycle as user actions
- Keep the queue as the single source of truth for all event activity

**Non-Goals:**

- Sandboxing / isolated-vm execution (actions run as plain functions in the host process)
- Concurrency (scheduler processes events sequentially for the MWE)
- SDK / DSL (actions are hardcoded in the entry point for now)
- Filesystem-backed queue (stays in-memory)
- Retry logic

## Decisions

### Action type uses function-based matching

The `Action` type is `{ name: string, match: (event: Event) => boolean, handler: (event: Event) => void }`.

The `match` function receives the full event and returns whether this action should handle it. This is more general than a static property map — it can match on `type`, `targetAction`, or any combination of event properties.

The DSL (when built later) will only expose event type matching as sugar, but underneath it registers actions with function predicates.

**Alternative considered:** Static match object `{ type: "...", targetAction: "..." }` with equality checks. Rejected because a function is strictly more expressive, equally simple for the common case, and avoids needing a matching engine.

### Dispatch is a built-in action, not a separate component

Dispatch registers as an `Action` with `match: (event) => event.targetAction === undefined`. When it runs, it scans all other registered actions to find subscribers for the event's type, then enqueues a cloned event for each subscriber with `targetAction` set.

This means every event goes through the queue twice: once as a raw event (handled by dispatch), once as a targeted event (handled by the user action). Both steps go through the full pending → processing → done/failed lifecycle.

**Why not a separate dispatcher component?** Both triggers and action emits need fan-out. Making dispatch an action means a single fan-out path through the queue. The scheduler stays simple — it just matches events to actions. The audit trail captures every step.

**How dispatch finds subscribers:** It iterates all registered actions and, for each one, constructs a synthetic event `{ ...event, targetAction: action.name }` and calls `action.match(syntheticEvent)`. If the action matches, it's a subscriber. This reuses the match functions rather than maintaining a separate subscriber registry.

### Scheduler match semantics: exactly one match required

When the scheduler dequeues an event, it filters all actions by `match(event)`:
- **0 matches:** Mark the event as done. Not an error — the event simply has no subscribers.
- **1 match:** Run that action's handler.
- **>1 match:** Fail the event. Ambiguous matching is a configuration bug.

### targetAction is added to Event

The `Event` type gains `targetAction?: string`. Events from triggers and action emits have `targetAction` unset. The dispatch action sets it when cloning events for each subscriber. The scheduler uses it (indirectly, via match functions) to route events to the correct action.

### Queue interface is promise-based with blocking dequeue

The `EventQueue` interface is fully async:
- `enqueue(event: Event): Promise<void>` — adds an event to the queue
- `dequeue(): Promise<Event>` — blocks until a pending event is available, then returns it marked as processing
- `ack(eventId: string): Promise<void>` — marks an event as done
- `fail(eventId: string): Promise<void>` — marks an event as failed

`dequeue()` blocks rather than returning `undefined`. This pushes the "wait for work" concern into the queue implementation and out of the scheduler. `InMemoryEventQueue` implements this with a pending promise that resolves when `enqueue` is called.

`InMemoryEventQueue` tracks event state internally. Events transition: pending → processing (on dequeue) → done (on ack) / failed (on fail).

### Scheduler is an await loop

The scheduler runs a simple loop: `await dequeue()` → match → run → ack/fail → repeat. No polling, no intervals — `dequeue()` blocks until work is available.

```
  await dequeue()
     │
     ├─ (blocks until event available)
     │
     ├─ event found
     │    │
     │    ├─ filter actions by match(event)
     │    │
     │    ├─ 0 matches → ack(event.id)
     │    ├─ 1 match   → handler(event) → ack(event.id)
     │    │                   │
     │    │              throw? → fail(event.id)
     │    ├─ >1 match  → fail(event.id)
     │    │
     │    └─ loop
```

## Risks / Trade-offs

**Two-hop latency** — Every event goes through the queue twice (dispatch + action). For in-memory this is negligible. For the filesystem queue, it means extra file operations per event. → Acceptable: the audit trail and architectural simplicity are worth it.

**Dispatch scans all actions** — For each raw event, dispatch iterates all registered actions to find subscribers. With hundreds of actions this could matter. → Fine for v1. Can be optimized with an index later if needed.

**Blocking dequeue complexity** — `InMemoryEventQueue.dequeue()` needs to manage pending promises that resolve on future enqueues. Slightly more complex than a simple array, but eliminates polling and keeps the scheduler trivial.
