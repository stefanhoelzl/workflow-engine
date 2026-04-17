## MODIFIED Requirements

### Requirement: One-shot startup recovery function

The runtime SHALL expose a `recover({ backend, eventStore }, bus)` startup function that runs once, after the `EventStore` has bootstrapped from the archive (i.e. after `eventStore.initialized` resolves) and before the HTTP server begins accepting requests.

The function SHALL iterate `scanPending(backend)` and group the yielded events by invocation id. For each group the function SHALL decide the recovery action using the event store as the authority:

1. If the event store contains any event for that invocation id, the archive is already durable (the prior process crashed during pending cleanup). The function SHALL call `backend.removePrefix("pending/{id}/")` to clear the stale pending files, SHALL log an info-level entry `runtime.recovery.archive-cleanup` with the id and the count of stale files, and SHALL NOT emit any event to the bus for that id.

2. Otherwise, the prior process crashed mid-invocation (no archive was written). The function SHALL emit each replayed pending event to the bus in seq order, then SHALL emit a synthetic `trigger.error` event whose `error` carries `{ kind: "engine_crashed" }`, whose seq is `max(pending seq) + 1`, whose `at` is `new Date().toISOString()` captured at recovery time, and whose `ts` is copied from the last replayed event's `ts` (or `0` if no events were replayed). The persistence consumer handles the synthetic terminal event by writing `archive/{id}.json` and calling `removePrefix` as part of its normal flow.

The synthetic event's `ts` is deliberately reused from the last replayed event rather than freshly sampled from a `performance.now()` anchor, because recovery runs outside any sandbox context and therefore has no anchor. The consequence is that `terminal.ts - request.ts` on a recovered invocation reads as "how far the run got before the crash," not the total wall-clock gap to recovery — which is the most informative value we can surface without fabricating precision we do not have.

Partial overlap (some pending seqs present in the event store, others not) SHALL NOT occur in practice because the archive is written exactly once on terminal, containing every event. If it nonetheless occurs, the function SHALL treat the id as "event store has events" (case 1) — the archive on disk is the authoritative record.

#### Scenario: Crashed mid-invocation — replay plus synthetic terminal

- **GIVEN** `pending/evt_a/000000.json` and `pending/evt_a/000001.json` exist on disk
- **AND** the second pending event has `ts = 4200`
- **AND** the event store contains no event for `evt_a`
- **WHEN** `recover({ backend, eventStore }, bus)` runs
- **THEN** the function SHALL emit the two replayed events to the bus in seq order
- **AND** SHALL emit a synthetic `trigger.error` event with seq 2, `error: { kind: "engine_crashed" }`, `ts = 4200`, and `at` matching the wall-clock time of emission
- **AND** after the function returns, no file under `pending/evt_a/` SHALL remain
- **AND** `archive/evt_a.json` SHALL contain a JSON array including the two original events and the synthetic terminal event

#### Scenario: Crashed during cleanup — archive-authoritative, no replay

- **GIVEN** `archive/evt_a.json` exists containing a complete event array (including a terminal event)
- **AND** `pending/evt_a/000003.json` and `pending/evt_a/000005.json` exist as stale leftovers from the prior cleanup
- **AND** the event store has been bootstrapped from the archive and contains events for `evt_a`
- **WHEN** `recover({ backend, eventStore }, bus)` runs
- **THEN** the function SHALL call `backend.removePrefix("pending/evt_a/")`
- **AND** SHALL log an info-level entry `runtime.recovery.archive-cleanup`
- **AND** SHALL NOT emit any event to the bus for `evt_a`
- **AND** after the function returns, no file under `pending/evt_a/` SHALL remain
- **AND** `archive/evt_a.json` SHALL remain byte-identical

#### Scenario: Empty pending is a no-op

- **GIVEN** the `pending/` prefix has no files
- **WHEN** `recover({ backend, eventStore }, bus)` runs
- **THEN** the function SHALL complete without emitting any event and without calling `removePrefix`
