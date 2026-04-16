## MODIFIED Requirements

### Requirement: Persistence consumer writes invocation lifecycle records

The persistence consumer SHALL implement `BusConsumer` and SHALL persist `InvocationEvent` records received from the bus.

For each event the consumer receives, it SHALL:

1. Write `pending/{id}/{seq}.json` containing the serialized `InvocationEvent`. The `seq` component SHALL be zero-padded to 6 digits on write (parsers accept any width).
2. After the pending write succeeds, append the event to an in-memory accumulator keyed by invocation id (`Map<string, InvocationEvent[]>`).

For each terminal event (`trigger.response` or `trigger.error`), after steps 1 and 2, the consumer SHALL:

3. Write a single `archive/{id}.json` file whose content is a JSON array of all events accumulated for that id, in seq order, including the terminal event.
4. Clear the accumulator entry for that id (before cleanup, so the accumulator invariant is preserved on cleanup failure).
5. Call `backend.removePrefix("pending/{id}/")` to remove the per-invocation pending directory. This call is best-effort.

If the `archive/{id}.json` write fails, the consumer SHALL log the failure, leave the accumulator entry intact, leave pending files on disk, and NOT call `removePrefix`. Next-startup recovery handles the resulting state via the archive-authoritative rule (see `recovery/spec.md`).

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
