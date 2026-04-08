## Why

The current `EventQueue` interface mixes work distribution (enqueue/dequeue/ack/fail) with persistence (filesystem writes) in a single monolithic abstraction. Future requirements (query store, SSE change stream, correlation summaries) need to observe every state change, but the queue only exposes a consumer-side API. Splitting into an event bus with ordered consumers decouples these concerns and makes the system extensible without modifying the core pipeline.

## What Changes

- **BREAKING**: Replace `EventQueue` interface, `InMemoryEventQueue`, and `FileSystemEventQueue` with a new `EventBus` architecture
- Introduce `EventBus` with ordered `BusConsumer` instances that receive every event state change
- Introduce `RuntimeEvent` type extending the SDK `Event` with lifecycle state and optional error
- Add `skipped` as a new terminal state for events with no matching action
- Split current filesystem queue into a persistence consumer (append-only FS log) and a work-queue consumer (passive buffer with blocking dequeue)
- ContextFactory depends on EventBus instead of EventQueue
- Scheduler depends on WorkQueue (dequeue) and EventBus (state transitions) instead of EventQueue
- Startup includes a batched bootstrap phase where persistence recovers events from disk and fans them out to other consumers

## Capabilities

### New Capabilities
- `event-bus`: Core EventBus interface, BusConsumer contract, RuntimeEvent schema, createEventBus factory, ordered consumer fan-out, and batched bootstrap protocol
- `persistence`: Filesystem append-only log consumer with atomic writes, fire-and-forget archiving on terminal states, and crash recovery via recover()
- `work-queue`: Passive bus consumer that buffers pending events and exposes a blocking dequeue() for the scheduler

### Modified Capabilities
- `events`: Add RuntimeEvent type (Event + state + error), add `skipped` state to the state model, events are immutable (bus carries full snapshots)
- `scheduler`: Depends on WorkQueue + EventBus instead of EventQueue. Scheduler owns all state transitions (processing/done/failed/skipped) via bus.emit(). No more ack/fail methods.
- `context`: ContextFactory depends on EventBus instead of EventQueue. Emitting creates a RuntimeEvent with state "pending" and calls bus.emit().

## Impact

- **Deleted modules**: `event-queue/index.ts` (EventQueue interface, EventSchema), `event-queue/in-memory.ts` (InMemoryEventQueue), `event-queue/fs-queue.ts` (FileSystemEventQueue)
- **New modules**: `event-bus/index.ts`, `event-bus/persistence.ts`, `event-bus/work-queue.ts`
- **Modified modules**: `context/index.ts` (ContextFactory), `services/scheduler.ts`, `main.ts` (startup orchestration with bootstrap)
- **SDK**: Add `Event` type export (currently only has `EventDefinition`)
- **Tests**: All queue-related tests must be rewritten. Tests use real bus with mock consumers.
- **No new external dependencies** for the bus itself (SQLite/Kysely deferred to QueryStore change)
