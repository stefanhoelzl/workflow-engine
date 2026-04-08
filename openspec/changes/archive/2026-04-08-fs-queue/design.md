## Context

The runtime processes events through a Trigger → Event → Action pipeline. Currently, `InMemoryEventQueue` is the sole `EventQueue` implementation — all pending events are lost on process restart. The `EventQueue` interface (`enqueue`, `dequeue`, `ack`, `fail`) is already well-abstracted, and the `Scheduler` consumes events sequentially in a single-consumer loop.

## Goals / Non-Goals

**Goals:**
- Pending events survive process restarts (crash recovery)
- Completed events retained on disk for auditing and future replay
- `FileSystemEventQueue` is a drop-in replacement conforming to `EventQueue`
- Shared contract tests ensure both implementations behave identically

**Non-Goals:**
- FIFO ordering guarantee (events are self-routed via `targetAction`/`correlationId`)
- Multi-process or distributed queue support
- Automatic retries (design accommodates future retries, but not implemented now)
- Cleanup/rotation of archived events

## Decisions

### 1. FileSystemEventQueue extends InMemoryEventQueue

`FileSystemEventQueue` inherits all in-memory logic (state tracking, waiter/Promise dequeue pattern) and layers filesystem I/O on top.

**Alternative considered**: Composition via an `EventStore` interface injected into a single `EventQueue` class. Rejected because there is only one real store implementation, and inheritance is simpler — the filesystem queue *is* an in-memory queue with persistence.

### 2. InMemoryEventQueue constructor accepts optional `Event[]`

The constructor takes an optional array of events to seed the initial pending entries. This is how `FileSystemEventQueue` feeds recovered events from disk into the inherited in-memory state without exposing private fields.

**Alternative considered**: Making `#entries` and `#waiters` protected. Rejected because it leaks internal structure; constructor seeding is a narrower, safer API.

### 3. Two directories: `pending/` and `archive/`

- `pending/` — events awaiting or currently being processed
- `archive/` — completed events (done or failed), full history preserved

Processing state is tracked purely in-memory. On crash recovery, everything in `pending/` is treated as pending.

**Alternative considered**: Four directories (`pending/`, `processing/`, `done/`, `failed/`) with rename-based state transitions. Rejected because tracking processing state on disk adds writes with no benefit — the single-consumer scheduler means at most one event is processing at a time, and on crash it should be requeued anyway.

### 4. Immutable, append-only event files

Each state transition writes a *new* file rather than mutating the original. Files are never modified after creation.

**File naming**: `<counter>_evt_<uuid>.json` with a global monotonic counter shared across all events. The counter provides a total chronological ordering of all operations for auditing. On startup, the counter is recovered by reading the max counter value from existing filenames.

**File content**: Self-contained — full event data plus state field. Every file is independently useful for auditing.

**Alternative considered**: Per-event serial numbers (`evt_<uuid>_0.json`, `evt_<uuid>_1.json`). Rejected because a global counter provides a cross-event chronological timeline for auditing, which per-event serials cannot.

### 5. Atomic write-then-rename

All file writes use a two-step pattern: write to a temporary file (`.tmp` suffix in the same directory), then `fs.rename()` to the final path. `rename()` is atomic on Linux/macOS within the same filesystem, preventing partial/corrupted JSON files.

### 6. Operation sequence for ack/fail

```
ack(eventId) / fail(eventId):
  1. Atomic-write terminal file (<counter>_evt_<id>.json) to pending/
  2. super.ack(eventId) / super.fail(eventId)  — update in-memory state
  3. Move all *_evt_<id>.json files from pending/ to archive/ (lowest counter first)
```

The state transition (steps 1-2) is separated from the housekeeping (step 3). The terminal file is persisted before in-memory state updates, so disk is always the source of truth. Archiving moves lowest serial first so that if the process crashes mid-archive, the highest-serial file remaining in `pending/` is authoritative.

All steps are awaited — archiving blocks before returning.

### 7. Async factory method for initialization

```typescript
const queue = await FileSystemEventQueue.create("./data/queue");
```

The factory method ensures `pending/` and `archive/` directories exist, reads all files from `pending/`, derives the global counter from the max counter in existing filenames, groups files by event ID, and determines state from the file with the highest counter per event:
- If terminal (done/failed): completes the interrupted archive (moves to `archive/`)
- If pending: passes event to `super()` for requeuing

### 8. No FIFO guarantee

The in-memory queue happens to be roughly FIFO, but the filesystem queue makes no ordering guarantee. Events are self-routed via `targetAction` and `correlationId`, so global ordering is not required for correctness.

### 9. Shared contract tests

Behavioral tests (enqueue/dequeue/ack/fail, blocking dequeue, multiple waiters) are extracted into a shared suite parameterized by queue implementation. `FileSystemEventQueue` tests use temporary directories.

## Risks / Trade-offs

**[At-least-once delivery]** → On crash, events in processing state are requeued and reprocessed. Action handlers must be idempotent or tolerate duplicates. This is acceptable for the current use case and standard for durable queues.

**[Disk I/O on hot path]** → `enqueue()` writes to disk synchronously (awaited). This adds latency compared to pure in-memory. Acceptable because the scheduler processes events sequentially — disk I/O is not the bottleneck. → If it becomes one, writes could be batched or made fire-and-forget for enqueue (recovery would lose at most one event).

**[Archive directory growth]** → Completed events accumulate indefinitely. → Future work: add a retention policy or rotation. Not needed now.

**[Global counter recovery]** → The counter must be recovered from disk on startup by scanning filenames in both `pending/` and `archive/`. If both directories are empty, the counter starts at 0. This adds a directory scan to startup but only happens once.
