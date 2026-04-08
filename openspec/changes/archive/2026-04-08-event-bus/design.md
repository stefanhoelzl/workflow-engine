## Context

The runtime currently uses an `EventQueue` interface that combines work distribution (enqueue/dequeue/ack/fail) with persistence (filesystem writes) in a single abstraction. `FileSystemEventQueue` extends `InMemoryEventQueue`, writing append-only JSON files for durability while delegating in-memory state to the parent class.

This design works for the current single-consumer model, but upcoming features (query store, SSE change stream, correlation summaries) need to observe every state transition. Bolting query methods onto the queue mixes concerns. An event bus architecture decouples the pipeline: events flow through a central bus, and independent consumers handle persistence, buffering, querying, and streaming.

## Goals / Non-Goals

**Goals:**
- Replace EventQueue with an EventBus that fans out state changes to ordered consumers
- Maintain crash recovery guarantees via filesystem append-only log
- Maintain blocking dequeue semantics for the scheduler
- Introduce RuntimeEvent as the canonical enriched event type
- Add `skipped` terminal state for unmatched events
- Enable future consumers (query store, SSE) without modifying the bus or existing consumers
- Keep events immutable — bus carries full snapshots, never mutates

**Non-Goals:**
- QueryStore implementation (SQLite/Kysely — separate change)
- SSE change stream implementation (separate change)
- HTTP API for queries (separate change)
- Parallel scheduling / concurrent event processing
- Event replay or reprocessing mechanisms

## Decisions

### 1. EventBus with ordered consumers over a layered store

**Decision:** Events flow through a central bus to ordered consumers. Each consumer is awaited in registration order.

**Alternatives considered:**
- *EventStore as source of truth with queue layered on top* — Clean ownership but couples persistence to querying. Adding consumers requires modifying the store.
- *Independent peers (queue + store)* — Dual-write problem, risk of state divergence.

**Rationale:** The bus model treats all concerns as equal consumers. Adding a new consumer (metrics, audit, SSE) is just another entry in the consumer array. Registration order provides implicit priority without a separate priority mechanism.

### 2. Filesystem persistence + SQLite query index (hybrid storage)

**Decision:** Filesystem remains the durable persistence layer. SQLite serves as a runtime query index rebuilt from FS on startup. SQLite is deferred to the QueryStore change.

**Rationale:** The FS append-only log is proven, provides a full audit trail, and survives process crashes. SQLite adds fast queries without replacing the durability model. Keeping them separate means either can be swapped independently.

### 3. Scheduler owns all state transitions

**Decision:** The scheduler emits all state transitions (processing, done, failed, skipped) directly to the bus. The WorkQueue is purely passive.

**Alternatives considered:**
- *WorkQueue emits processing on dequeue* — Creates circular dependency: WorkQueue needs bus reference, bus holds WorkQueue as consumer.
- *State transitions via intermediary* — Adds indirection without benefit.

**Rationale:** Eliminates circular dependency. All state transitions happen in one place (scheduler), making the flow easy to trace. WorkQueue becomes a simple buffer with no outbound side effects.

### 4. Batched bootstrap with finish signal

**Decision:** On startup, persistence scans FS files and yields batches. Bus calls `bootstrap(batch, {finished})` on each consumer per batch. Last call gets `{finished: true}`.

**Alternatives considered:**
- *Single bootstrap call with all events* — Loads all events into memory at once. Doesn't scale.
- *Replay through bus.emit()* — FS consumer would re-persist events it already has (circular).

**Rationale:** Batched bootstrap keeps memory bounded. The `finished` signal lets consumers defer expensive operations (e.g., index creation) until all data is loaded. Persistence's `bootstrap()` is a no-op since it provides the data.

### 5. RuntimeEvent as immutable snapshots

**Decision:** The bus carries full RuntimeEvent snapshots. State transitions create new objects via spread (`{...event, state: "done"}`). Events are never mutated in place.

**Rationale:** Immutability aligns with the append-only FS model. Each file on disk is a snapshot at a point in time. No mutation means no shared-state bugs and no need for defensive copies.

### 6. Fire-and-forget archive on terminal states

**Decision:** When persistence writes a terminal state file (done/failed/skipped), it kicks off archiving (moving files to `archive/`) without awaiting it.

**Alternatives considered:**
- *Await archive in handle()* — Blocks the bus pipeline for a non-critical operation.
- *Background cleanup task* — More infrastructure for a simple file move.

**Rationale:** Archiving is a cleanup operation, not a durability requirement. The terminal state file is already written (and awaited). The archive move can happen in the background without blocking other consumers.

### 7. Single-threaded counter with documented limitation

**Decision:** The file counter is a simple in-memory integer, incremented on each write. Not safe for concurrent writes.

**Rationale:** The bus awaits each consumer sequentially, so persistence.handle() is always single-threaded. Documenting the limitation ensures it's addressed when parallel scheduling is introduced.

## Risks / Trade-offs

**[Risk] Bus consumer failure blocks the pipeline** → Since consumers are awaited in order, a slow or failing consumer blocks all subsequent consumers. Mitigation: persistence is first (most critical), other consumers should be fast. Future: add timeout/circuit-breaker per consumer if needed.

**[Risk] Fire-and-forget archive loses files on crash** → If the process crashes after writing the terminal state file but before archiving, files remain in `pending/`. Mitigation: recovery already handles this — terminal state files in `pending/` are archived on next startup.

**[Risk] Bootstrap memory pressure with many events** → Batched bootstrap mitigates this, but each batch still loads N events. Mitigation: batch size is configurable via the persistence consumer.

**[Trade-off] No ack/fail/skip API** → The bus model replaces explicit methods with `bus.emit({state})`. This is simpler but less self-documenting than named methods. Accepted: the state field is explicit enough, and the scheduler is the only emitter.

**[Trade-off] All consumers see all state transitions** → Consumers must filter internally (e.g., WorkQueue ignores non-pending events). This is a small cost for the extensibility benefit.

## Sequence: Event Processing

```
Trigger              ContextFactory           EventBus            Persistence    WorkQueue     Scheduler
  │                       │                      │                    │              │              │
  │──emit(type,payload)──►│                      │                    │              │              │
  │                       │──bus.emit(pending)───►│                    │              │              │
  │                       │                      │──handle(pending)──►│              │              │
  │                       │                      │   (write file)     │              │              │
  │                       │                      │◄──────────────────-│              │              │
  │                       │                      │──handle(pending)──────────────────►│             │
  │                       │                      │                    │   (buffer)    │              │
  │                       │                      │◄─────────────────────────────────-─│             │
  │                       │◄─────────────────────│                    │              │              │
  │◄──────────────────────│                      │                    │              │              │
  │                       │                      │                    │              │              │
  │                       │                      │                    │    dequeue()──►│             │
  │                       │                      │                    │              │──(event)────►│
  │                       │                      │◄──bus.emit(processing)────────────────────────-──│
  │                       │                      │──handle(processing)►│             │              │
  │                       │                      │──handle(processing)──────────────►│ (ignore)     │
  │                       │                      │                    │              │              │
  │                       │                      │                    │              │  (run action) │
  │                       │                      │                    │              │              │
  │                       │                      │◄──bus.emit(done)──────────────────────────────-──│
  │                       │                      │──handle(done)─────►│              │              │
  │                       │                      │   (write + archive)│              │              │
  │                       │                      │──handle(done)──────────────────-──►│ (ignore)    │
```

## Sequence: Startup / Recovery

```
main.ts              Persistence              EventBus            WorkQueue
  │                       │                      │                    │
  │──recover()───────────►│                      │                    │
  │                       │──(scan FS files)     │                    │
  │◄──batch 1────────────-│                      │                    │
  │──bus.bootstrap(b1)───────────────────────────►│                   │
  │                       │                      │──bootstrap(b1)────►│ (no-op)
  │                       │                      │──bootstrap(b1)─────────────────-──►│ (buffer)
  │◄──batch 2────────────-│                      │                    │              │
  │──bus.bootstrap(b2)───────────────────────────►│                   │              │
  │                       │                      │   ...              │              │
  │──bus.bootstrap([],{finished:true})───────────►│                   │              │
  │                       │                      │──bootstrap([],fin)─►│             │
  │                       │                      │──bootstrap([],fin)──────────────-─►│ (ready)
  │                       │                      │                    │              │
  │──start scheduler─────────────────────────────────────────────────────────────────►│
```
