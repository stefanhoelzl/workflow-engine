## Context

The runtime currently has two core abstractions for events: `EventFactory` (creates/derives/forks RuntimeEvents) and `EventBus` (emits events to consumers). Every consumer of EventFactory also depends on EventBus — they are always passed together to `ContextFactory` and `Scheduler`. The pattern is always "factory creates event → bus emits it", with the caller responsible for wiring both steps.

Additionally, event lifecycle logging is scattered: `ContextFactory.#logEmit` logs new event creation, the Scheduler logs action lifecycle (`action.started`, `action.completed`, `action.failed`) and routing (`event.no-match`, `event.fanout`, `event.fanout.skipped`), and `main.ts` logs recovery counts. These scheduler logs are redundant with event state transitions that already flow through the bus.

RuntimeEvents currently carry a single `createdAt` timestamp. Duration metrics (queue wait, execution time) require correlating multiple event rows — the `processing` row's timestamp minus the `pending` row's timestamp. This makes events non-self-sufficient for timing analysis.

## Goals / Non-Goals

**Goals:**

- Unify EventFactory and EventBus usage into a single `EventSource` that auto-emits on create/derive/fork
- Add a `transition()` method to EventSource for state changes, replacing direct `bus.emit({...event, state})` calls
- Add lifecycle timestamps (`emittedAt`, `startedAt`, `doneAt`) so each event row is self-sufficient for duration analysis
- Rename `createdAt` to `emittedAt` (per-emit timestamp) and use `createdAt` for the immutable event birth time
- Centralize all event lifecycle logging into a single bus consumer
- Eliminate `HttpTriggerContext`, `Context` interface, `EmitOptions`, and `ContextFactory` class
- Remove the Scheduler's logger dependency

**Non-Goals:**

- Changing the EventBus interface or BusConsumer contract
- Upsert/deduplication in the event store (multiple rows per event ID stays)
- Changing the SDK's ActionContext API beyond removing EmitOptions
- Modifying the persistence or work queue consumers
- Changing the sandbox boundary

## Decisions

### D1: EventSource receives bus as dependency, does not own it

The bus is passed to `createEventSource(schemas, bus)` at construction. EventSource uses it internally for auto-emit, but the bus remains independently accessible — `main.ts` passes it directly to recovery for `bus.bootstrap()`.

**Alternative: Bus internal to EventSource.** Would require exposing a `bootstrap()` method on EventSource, conflating two concerns (event creation vs. recovery replay). Rejected because recovery is a separate lifecycle phase that doesn't involve event creation.

### D2: create/derive/fork auto-emit and return the event

All three methods call `bus.emit()` as a side effect and return the `RuntimeEvent`. Callers that need the event for logging or inspection still get it. This is the least disruptive change — existing call sites just drop their `bus.emit()` call.

**Alternative: Return void.** Would require reworking ActionContext's emit callback and ContextFactory logging. Rejected as unnecessarily disruptive.

### D3: transition() with discriminated union types

A single `transition(event, opts)` method handles all state changes. TypeScript's discriminated unions enforce:
- `{ state: "processing" }` — no result
- `{ state: "done", result: "skipped" | "succeeded" }` — no error
- `{ state: "done", result: "failed", error: string }` — error required

The method sets `emittedAt = now` on every call, `startedAt = now` on processing, and `doneAt = now` on done (with `startedAt` backfilled to `doneAt` if the event skipped processing).

**Alternative: Named methods (processing(), succeeded(), failed(), skipped()).** More readable at call sites but more API surface. Rejected for simplicity.

### D4: Lifecycle timestamps on RuntimeEvent

New fields: `emittedAt` (per-emit, set on every emit), `startedAt` (set by processing transition), `doneAt` (set by done transition). The existing `createdAt` field becomes the immutable event birth time (set once by create/derive/fork, carried through transitions).

This makes each event row self-sufficient for duration analysis:
- Queue wait: `startedAt - createdAt`
- Execution: `doneAt - startedAt`
- Total: `doneAt - createdAt`

Events that skip processing (done/skipped directly) get `startedAt = doneAt`.

### D5: Remove HttpTriggerContext — middleware calls EventSource directly

`HttpTriggerContext` is a thin wrapper that only holds `request.body`, `definition`, and an `emit()` callback. The middleware itself calls `emit()` — no user handler code sees this context. Replacing it with a direct `source.create()` call eliminates the class, the `TriggerContextFactory` type, and the `httpTrigger` method on ContextFactory.

**Alternative: Keep HttpTriggerContext for future extensibility.** Rejected — YAGNI. Can always be re-introduced if triggers become more complex.

### D6: Inline ContextFactory as createActionContext() function

With HttpTriggerContext removed, ContextFactory only has `action()`. A class with one method is over-abstraction. Replace with `createActionContext(source, fetch, env, logger)` that returns `(event: RuntimeEvent) => ActionContext`.

### D7: Remove EmitOptions and targetAction from ctx.emit()

`EmitOptions` only contained `targetAction`, which was speculative API surface — not used in the SDK, no example code, only one test. The only legitimate source of `targetAction` is `EventSource.fork()` in the scheduler. Removing it simplifies the user-facing emit API.

### D8: Logging bus consumer replaces scattered logging

A new `LoggingConsumer` implements `BusConsumer` and replaces:
- `ContextFactory.#logEmit` (event.emitted at info, event.emitted.payload at trace)
- All 6 scheduler logger calls (action.started/completed/failed, event.no-match, event.fanout, event.fanout.skipped)
- `main.ts` recovery count log

Log levels:
- `pending` events → info (new event created)
- `processing` transitions → trace
- `done` transitions → trace (or error if result=failed)
- `bootstrap()` → info with count

The consumer is placed **after persistence** in the consumer chain, so logs confirm what's already durable.

### D9: Scheduler drops logger dependency

With all event lifecycle logging moved to the bus consumer, the scheduler no longer needs a Logger. Its only remaining concerns are orchestration: matching actions, fan-out, executing handlers.

## Risks / Trade-offs

**[Risk] Auto-emit makes create/derive/fork async** → These methods are currently sync. Adding `bus.emit()` makes them async (returns `Promise<RuntimeEvent>`). All call sites must be awaited. Mitigation: the existing call sites already await the subsequent `bus.emit()`, so the change is straightforward.

**[Risk] Logging consumer sees all events, including transitions** → More log volume than today's targeted logging. Mitigation: trace level for transitions (processing, done) keeps default log output unchanged.

**[Risk] Event store schema change (new timestamp columns)** → DuckDB is in-memory, rebuilt on startup from persisted events. Old persisted events won't have the new fields. Mitigation: make `emittedAt`, `startedAt`, `doneAt` nullable in the schema; old events get nulls. The persistence format on disk also needs to handle the new fields — ensure `RuntimeEventSchema` parsing coerces missing fields to undefined.

**[Trade-off] EventSource has more responsibility than EventFactory** → It now creates events AND emits them AND transitions state. This is intentional — the combined API eliminates the "create then emit" pattern that was the source of coupling.

## Flows

### HTTP Trigger → Event Creation (after)

```
  POST /webhooks/order
         │
         ▼
  httpTriggerMiddleware
         │
         │  source.create("order.received", body)
         │       │
         │       ├── validate payload
         │       ├── construct RuntimeEvent { createdAt, emittedAt }
         │       └── bus.emit(event)
         │              │
         │              ├── persistence.handle(event)
         │              ├── workQueue.handle(event)
         │              ├── eventStore.handle(event)
         │              └── logging.handle(event) → info "event.created"
         │
         ▼
  return static response
```

### Action Execution (after)

```
  scheduler dequeues event
         │
         │  source.transition(event, { state: "processing" })
         │       │
         │       ├── set emittedAt, startedAt
         │       └── bus.emit({...event, state: "processing"})
         │              └── consumers... → logging: trace "event.processing"
         │
         │  action.handler(ctx)
         │       │
         │       ├── ctx.emit("order.validated", payload)
         │       │       └── source.derive(event, type, payload)
         │       │              └── bus.emit(derived) → logging: info "event.created"
         │       │
         │       └── (handler completes)
         │
         │  source.transition(event, { state: "done", result: "succeeded" })
         │       │
         │       ├── set emittedAt, doneAt
         │       └── bus.emit({...event, state: "done"})
         │              └── consumers... → logging: trace "event.done"
```

### Fan-Out (after)

```
  scheduler dequeues undirected event
         │
         │  source.transition(event, { state: "processing" })
         │
         │  for each matching action:
         │     source.fork(event, { targetAction: action.name })
         │       │
         │       ├── construct forked RuntimeEvent
         │       └── bus.emit(forked) → logging: info "event.created"
         │
         │  source.transition(event, { state: "done", result: "succeeded" })
```
