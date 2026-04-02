## Context

The HTTP trigger fires a callback with the trigger definition and parsed request body. Currently this goes to `console.log`. This change introduces the minimal event and queue abstractions so trigger payloads flow into a queue instead of nowhere.

## Goals / Non-Goals

**Goals:**
- Define a minimal `Event` type sufficient for this step
- Define an `EventQueue` interface with `enqueue` only
- Implement `InMemoryEventQueue` as a simple array-backed store
- Wire the trigger callback to create events and enqueue them

**Non-Goals:**
- Full event metadata (correlationId, traceId, parentEventId, targetAction, status) — added when actions and tracing exist
- Consuming events from the queue (dequeue, markProcessing, ack, fail) — added when the scheduler lands
- Filesystem-backed queue — added as a separate change
- Runtime validation of event payloads (compile-time only per spec)
- Tests for InMemoryEventQueue — it's throwaway, later becomes the test double
- Event type registry or defineEvent DSL — that's SDK work

## Decisions

### 1. Minimal event shape

**Choice**: `Event` has four fields: `id`, `type`, `payload`, `createdAt`.

**Rationale**: The full spec defines rich metadata (correlationId, traceId, parentEventId, targetAction, status). None of these are meaningful yet — there are no actions to target, no traces to follow, no status transitions. Adding them now would mean inventing placeholder values. The type will grow when consumers need it.

### 2. Event type comes from the trigger definition

**Choice**: `HttpTriggerDefinition` gains an `event` field (e.g., `"order.received"`). The onTrigger callback uses `definition.event` as the event type.

**Alternatives considered**:
- Auto-derive from path/method (e.g., `"http.order.POST"`) — couples the event type to HTTP routing details, not the domain.
- Separate mapping table — unnecessary indirection.

**Rationale**: The trigger author knows what domain event they're producing. The event type is a domain concept, not an HTTP concept.

### 3. Event ID format

**Choice**: `evt_` prefix + `crypto.randomUUID()`.

**Rationale**: The spec says event IDs are prefixed with `evt_`. UUID is available in Node.js with zero dependencies. ULID (time-sortable) would be better for filesystem ordering but doesn't matter for in-memory. Can switch to ULID when the filesystem queue lands.

### 4. Interface name: EventQueue, not QueueStore

**Choice**: `EventQueue` with file at `src/event-queue/index.ts`.

**Rationale**: `EventQueue` is domain-first — it says what it is. `QueueStore` is pattern-first. The interface lives in `event-queue/index.ts` alongside the `Event` type since they're tightly coupled.

### 5. enqueue-only interface

**Choice**: `EventQueue` exposes only `enqueue(event: Event): void`.

**Rationale**: YAGNI. The consumer side (dequeue, ack, fail) doesn't exist yet. Adding methods with no callers creates untested surface area. The interface grows when the scheduler needs it.

### 6. Event construction in main.ts callback

**Choice**: The `onTrigger` callback in `main.ts` constructs the event inline and calls `queue.enqueue()`.

**Alternatives considered**:
- `createEvent()` factory function — adds indirection for a two-line operation.
- Dispatcher layer between trigger and queue — useful for fan-out, not needed yet.

**Rationale**: At this stage there's one trigger and one queue. The callback is the natural place. When fan-out or action routing arrives, a dispatcher can be extracted.

### 7. No tests for InMemoryEventQueue

**Choice**: Skip unit tests for the in-memory implementation.

**Rationale**: It's a temporary stepping stone. The filesystem queue is the real implementation. InMemoryEventQueue will later serve as the test double for other components (scheduler, dispatcher). Testing a test double is circular.

## Data Flow

```
  POST /webhooks/order  { orderId: "123" }
       │
       ▼
  ┌─────────────────────┐
  │  httpTriggerMiddle-  │
  │  ware                │
  │  → onTrigger(def,    │
  │    body)             │
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  onTrigger callback  │
  │  (in main.ts)        │
  │                      │
  │  1. create Event:    │
  │     id: evt_<uuid>   │
  │     type: def.event  │
  │     payload: body    │
  │     createdAt: now   │
  │  2. queue.enqueue()  │
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  InMemoryEventQueue  │
  │  [Event, Event, ...] │
  └─────────────────────┘
```
