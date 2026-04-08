## MODIFIED Requirements

### Requirement: InMemoryEventQueue implementation

`InMemoryEventQueue` SHALL implement the `EventQueue` interface using an in-memory array with state tracking. The constructor SHALL accept an optional `Event[]` parameter to seed the initial pending entries.

#### Scenario: Event lifecycle in memory

- **GIVEN** an `InMemoryEventQueue`
- **WHEN** an event is enqueued, then dequeued, then acked
- **THEN** the event transitions through pending → processing → done

#### Scenario: Multiple events in queue

- **GIVEN** an `InMemoryEventQueue` with three pending events
- **WHEN** `dequeue()` is called
- **THEN** the first pending event is returned
- **AND** the remaining two are still pending

#### Scenario: Constructor with initial events

- **GIVEN** an array of two events
- **WHEN** `new InMemoryEventQueue(events)` is called
- **THEN** both events SHALL be available via `dequeue()` in pending state

#### Scenario: Constructor without initial events

- **WHEN** `new InMemoryEventQueue()` is called
- **THEN** the queue SHALL be empty
- **AND** `dequeue()` SHALL block until an event is enqueued

## REMOVED Requirements

### Requirement: Filesystem implementation

**Reason**: Replaced by the new `fs-queue` capability which uses a 2-directory model (`pending/`, `archive/`) with immutable append-only files instead of the 4-directory rename-based design.
**Migration**: Use `FileSystemEventQueue` from the `fs-queue` capability.

### Requirement: Atomic state transitions

**Reason**: Superseded by the atomic write-then-rename pattern in `fs-queue`. State transitions no longer use `fs.rename` between directories — instead, new immutable files are written atomically.
**Migration**: See `fs-queue` spec for the new atomic write pattern.

### Requirement: Crash recovery on startup

**Reason**: Replaced by the `fs-queue` capability's recovery logic which reads `pending/` only (no `processing/` directory) and uses highest-serial-number file per event to determine state.
**Migration**: See `fs-queue` spec for the new crash recovery behavior.

### Requirement: In-memory pending list

**Reason**: This requirement described a specific implementation detail (in-memory list alongside filesystem). The new design achieves this through inheritance — `FileSystemEventQueue` extends `InMemoryEventQueue`, so the in-memory list is inherited naturally.
**Migration**: No migration needed; behavior is preserved through inheritance.

### Requirement: Append-only retention

**Reason**: Replaced by `fs-queue`'s immutable append-only file model which provides stronger guarantees (files never modified, not just never deleted).
**Migration**: See `fs-queue` spec's self-contained event files and archive requirements.
