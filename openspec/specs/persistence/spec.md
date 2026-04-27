# Persistence Specification

## Purpose

Provide crash-resilient invocation persistence using pending/archive lifecycle records, ensuring invocations survive process restarts through atomic writes and startup recovery.

## Requirements

### Requirement: Persistence consumer implements BusConsumer

The persistence consumer SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function that accepts a `StorageBackend` instance and returns an object with `name`, `strict`, and `handle`.

The persistence consumer SHALL declare `name === "persistence"` and `strict === true`. The `strict` flag is load-bearing: persistence is the durability boundary for invocation events, so a thrown rejection from `handle` is a runtime-fatal condition. Per the event-bus contract (see `event-bus/spec.md § Requirement: EventBus interface`), the bus logs `runtime.fatal { reason: "bus-strict-consumer-failed", … }` and terminates the process when a strict consumer throws — callers of `bus.emit` (executor, recovery) do not see the rejection because `bus.emit` never resolves under that path.

#### Scenario: Factory creates persistence consumer with strict tier

- **GIVEN** a `StorageBackend` instance
- **WHEN** the persistence factory is called with the backend
- **THEN** the returned object implements `BusConsumer` (`name`, `strict`, `handle`)
- **AND** the returned object's `name` SHALL equal `"persistence"`
- **AND** the returned object's `strict` SHALL equal `true`

### Requirement: Persistence consumer writes invocation lifecycle records

The persistence consumer SHALL implement `BusConsumer` and SHALL persist `InvocationEvent` records received from the bus.

For each event the consumer receives, it SHALL:

1. Write `pending/{id}/{seq}.json` containing the serialized `InvocationEvent`. The `seq` component SHALL be zero-padded to 6 digits on write (parsers accept any width).
2. After the pending write succeeds, append the event to an in-memory accumulator keyed by invocation id (`Map<string, InvocationEvent[]>`).

For each terminal event (`trigger.response` or `trigger.error`), after steps 1 and 2, the consumer SHALL:

3. Write a single `archive/{id}.json` file whose content is a JSON array of all events accumulated for that id, in seq order, including the terminal event.
4. Clear the accumulator entry for that id (before cleanup, so the accumulator invariant is preserved on cleanup failure).
5. Call `backend.removePrefix("pending/{id}/")` to remove the per-invocation pending directory. This call is best-effort.

If the `archive/{id}.json` write fails, the consumer SHALL log the failure, leave the accumulator entry intact, leave pending files on disk, and NOT call `removePrefix`. Next-startup recovery handles the resulting state via the archive-authoritative rule (see `recovery/spec.md` § _Requirement: One-shot startup recovery function_, case 1).

If `removePrefix` fails after a successful archive write, the consumer SHALL log the failure. The accumulator is already cleared; stale pending files are cleaned up by next-startup recovery.

The consumer SHALL update the accumulator only after the corresponding pending write succeeds (never before).

#### Scenario: Non-terminal event writes pending file and accumulates

- **WHEN** the consumer handles an event for id `evt_a` with seq `1` whose kind is non-terminal
- **THEN** the consumer SHALL write `pending/evt_a/000001.json` containing the serialized event
- **AND** the accumulator entry for `evt_a` SHALL include the event

#### Scenario: Terminal event writes single archive file then removes pending prefix

- **GIVEN** the consumer has already handled non-terminal events for `evt_a` with seqs 0, 1, 2
- **WHEN** the consumer handles a `trigger.response` event with seq 3
- **THEN** the consumer SHALL write `pending/evt_a/000003.json`
- **AND** the consumer SHALL write `archive/evt_a.json` containing a JSON array of all four events in seq order
- **AND** the consumer SHALL clear the accumulator entry for `evt_a`
- **AND** the consumer SHALL call `backend.removePrefix("pending/evt_a/")`

#### Scenario: Terminal error event archives the same way

- **GIVEN** the consumer is mid-invocation for `evt_a`
- **WHEN** the consumer handles a `trigger.error` terminal event
- **THEN** the consumer SHALL write `archive/evt_a.json` containing a JSON array of all events including the error
- **AND** SHALL call `backend.removePrefix("pending/evt_a/")`

#### Scenario: Archive write failure leaves pending and accumulator intact

- **GIVEN** the consumer is handling a terminal event for `evt_a`
- **WHEN** `backend.write("archive/evt_a.json", …)` throws
- **THEN** the consumer SHALL log the failure
- **AND** SHALL NOT clear the accumulator entry
- **AND** SHALL NOT call `removePrefix`
- **AND** pending files under `pending/evt_a/` SHALL remain on disk

#### Scenario: removePrefix failure after successful archive is logged but does not block

- **GIVEN** the consumer has successfully written `archive/evt_a.json`
- **WHEN** `backend.removePrefix("pending/evt_a/")` rejects
- **THEN** the consumer SHALL log the failure
- **AND** the accumulator entry for `evt_a` SHALL already be cleared
- **AND** the terminal event handling SHALL be considered complete for the bus's purposes

### Requirement: Atomic file writes via StorageBackend

All file writes SHALL be delegated to `StorageBackend.write()`. The backend is responsible for atomicity (FS uses tmp+rename, S3 uses PutObject). The persistence consumer SHALL NOT use `node:fs/promises` directly.

#### Scenario: Write delegates to StorageBackend

- **GIVEN** a persistence consumer created with a `StorageBackend`
- **WHEN** any lifecycle event triggers a file write
- **THEN** the consumer SHALL call `backend.write(path, data)`

### Requirement: Persistence exposes scan helpers for recovery

The persistence module SHALL expose `scanPending()` and `scanArchive()` async iterators yielding `InvocationEvent` objects.

- `scanPending(backend)` SHALL iterate `backend.list("pending/")`, parse each `pending/{id}/{seq}.json` path, read the file content, and yield the parsed `InvocationEvent` — one per pending file.
- `scanArchive(backend)` SHALL iterate `backend.list("archive/")`, read each `archive/{id}.json` file, parse its JSON-array body, and yield each element as an `InvocationEvent` — one per element across all archive files.

Both helpers SHALL skip paths that do not match the expected format and SHALL skip files whose content fails to parse. These helpers SHALL NOT be wired through the bus; they are called by recovery startup and the `EventStore` bootstrap directly.

#### Scenario: scanPending yields one event per pending file

- **GIVEN** `pending/evt_a/000000.json`, `pending/evt_a/000001.json`, and `pending/evt_b/000000.json` exist
- **WHEN** `scanPending(backend)` is iterated
- **THEN** the iterator SHALL yield three `InvocationEvent` objects — two for `evt_a` (seqs 0, 1) and one for `evt_b` (seq 0)

#### Scenario: scanArchive yields all events from all archive files

- **GIVEN** `archive/evt_a.json` contains a JSON array of 4 events and `archive/evt_b.json` contains a JSON array of 2 events
- **WHEN** `scanArchive(backend)` is iterated
- **THEN** the iterator SHALL yield 6 `InvocationEvent` objects across the two invocations

#### Scenario: scanArchive skips malformed archive files

- **GIVEN** `archive/evt_c.json` contains invalid JSON
- **AND** `archive/evt_d.json` contains a valid JSON array of events
- **WHEN** `scanArchive(backend)` is iterated
- **THEN** the iterator SHALL skip `evt_c` and SHALL still yield events from `evt_d`

### Requirement: Pending write failure is fatal

When `backend.write("pending/{id}/{seq}.json", …)` rejects, the persistence consumer SHALL re-throw the underlying error from `handle`. The accumulator entry for the invocation SHALL NOT be updated (matching the existing rule that the accumulator updates only after the corresponding pending write succeeds).

A pending-write rejection means the event is lost from the durability layer (it never landed on disk and the in-memory accumulator does not have it either, so the eventual archive write would also be incomplete). Per the event-bus strict-consumer contract (see `event-bus/spec.md § Requirement: EventBus interface`), this throw causes the bus to log `runtime.fatal { reason: "bus-strict-consumer-failed", consumer: "persistence", … }` and terminate the process. Next-startup recovery's existing orphan-`pending/` reconciliation closes the affected invocation as `trigger.error` (or as `archive-cleanup` if the prior process happened to write the archive but not clean up).

This requirement makes the existing behaviour explicit; it is implicitly required today by the rule that the accumulator updates only after the pending write succeeds, but the failure consequences were never spelled out.

#### Scenario: Pending write rejection re-throws and leaves accumulator untouched

- **GIVEN** the persistence consumer is handling event seq=3 for invocation `evt_a` with seqs 0..2 already in the accumulator
- **WHEN** `backend.write("pending/evt_a/000003.json", …)` rejects with `Error("storage offline")`
- **THEN** the consumer's `handle` SHALL re-throw `Error("storage offline")`
- **AND** the accumulator entry for `evt_a` SHALL still hold exactly seqs 0..2 (no entry for seq=3)
- **AND** under the bus's strict-consumer contract, this rethrow SHALL trigger the bus's fatal-exit path (`runtime.fatal` log + `process.exit(1)`)
