# Recovery Specification

## Purpose

Provide startup recovery for crashed pending invocations and EventStore bootstrapping from the archive.

## Requirements

### Requirement: One-shot startup recovery function

The runtime SHALL expose a `recover({ backend, eventStore }, bus)` startup function that runs once, after the `EventStore` has bootstrapped from the archive (i.e. after `eventStore.initialized` resolves) and before the HTTP server begins accepting requests.

The function SHALL iterate `scanPending(backend)` and group the yielded events by invocation id. For each group the function SHALL decide the recovery action using the event store as the authority:

1. If the event store contains any event for that invocation id, the archive is already durable (the prior process crashed during pending cleanup). The function SHALL call `backend.removePrefix("pending/{id}/")` to clear the stale pending files, SHALL log an info-level entry `runtime.recovery.archive-cleanup` with the id and the count of stale files, and SHALL NOT emit any event to the bus for that id.

2. Otherwise, the prior process crashed mid-invocation (no archive was written). The function SHALL emit each replayed pending event to the bus in seq order, then SHALL emit a synthetic `trigger.error` event with the following fields:

   - `kind`: `"trigger.error"`.
   - `seq`: `max(pending seq) + 1`.
   - `ref`: `null`. The synthetic terminal does not pair with any emitted request — recovery runs outside the executor's request/response lifecycle and has no prior seq to reference.
   - `at`: `new Date().toISOString()` captured at recovery time.
   - `ts`: copied from the last replayed event's `ts` (or `0` if no events were replayed).
   - `id`, `tenant`, `workflow`, `workflowSha`, `name`: copied from the first replayed event of the group (all replayed events for an id share these fields).
   - `error`: `{ message: "engine crashed before invocation completed", stack: "", kind: "engine_crashed" }`.

   The persistence consumer handles the synthetic terminal event by writing `archive/{id}.json` and calling `removePrefix` as part of its normal flow.

**Cold-start synthesis is structurally distinct from in-process synthesis.** In-process synthesis (sandbox observes worker death mid-run) is performed by the sandbox's `RunSequencer.finish({ closeReason })` against an in-memory sequencer that already saw the run's prior events. Recovery runs in a fresh process where the owning sandbox no longer exists; there is no live `RunSequencer` to consult. Recovery SHALL therefore derive `seq` by reading the highest persisted seq from disk and incrementing — this `lastPersistedSeq + 1` derivation is unique to recovery and SHALL NOT be replicated in any other code path. The `bridge-main-sequencing` change explicitly preserves this carve-out: the in-memory sequencer abstraction does NOT extend to cold-start synthesis.

The synthetic event's `ts` is deliberately reused from the last replayed event rather than freshly sampled from a `performance.now()` anchor, because recovery runs outside any sandbox context and therefore has no anchor.

Partial overlap (some pending seqs present in the event store, others not) SHALL NOT occur in practice because the archive is written exactly once on terminal, containing every event. If it nonetheless occurs, the function SHALL treat the id as "event store has events" (case 1).

#### Scenario: Crashed mid-invocation — replay plus synthetic terminal

- **GIVEN** `pending/evt_a/000000.json` and `pending/evt_a/000001.json` exist on disk
- **AND** the second pending event has `ts = 4200`
- **AND** the event store contains no event for `evt_a`
- **WHEN** `recover({ backend, eventStore }, bus)` runs
- **THEN** the function SHALL emit the two replayed events to the bus in seq order
- **AND** SHALL emit a synthetic `trigger.error` event with seq 2, `ref: null`, `error: { message: "engine crashed before invocation completed", stack: "", kind: "engine_crashed" }`, `ts = 4200`, and `at` matching the wall-clock time of emission
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

#### Scenario: Empty pending is a no-op

- **GIVEN** the `pending/` prefix has no files
- **WHEN** `recover({ backend, eventStore }, bus)` runs
- **THEN** the function SHALL complete without emitting any event and without calling `removePrefix`

#### Scenario: Recovery does not consult an in-memory RunSequencer

- **GIVEN** a recovering process with crashed pendings on disk
- **WHEN** `recover()` synthesises the terminal `trigger.error`
- **THEN** the synthetic event's `seq` SHALL be derived from the persisted pending events' max seq + 1
- **AND** the recovery code path SHALL NOT instantiate, import, or call any `RunSequencer` API
- **AND** the recovery code path SHALL NOT consult any `Sandbox` instance for sequencing

### Requirement: EventStore bootstraps from archive scan independently

The EventStore consumer SHALL bootstrap its in-memory index by scanning `archive/` directly at consumer-init time, NOT by replaying `loaded` events through the bus. After init, the EventStore SHALL receive runtime updates exclusively via bus lifecycle events.

#### Scenario: EventStore index populated from archive at init

- **GIVEN** an `archive/` directory containing N invocation records from prior sessions
- **WHEN** the EventStore consumer initializes
- **THEN** the consumer SHALL read all N records and insert them into its DuckDB index
- **AND** the consumer SHALL NOT require any `loaded` lifecycle events to populate this initial state

#### Scenario: Recovery emits failed events that EventStore consumes

- **GIVEN** the EventStore consumer has bootstrapped from archive
- **WHEN** `recover()` emits `failed` events for crashed pending entries
- **THEN** the EventStore consumer SHALL index each emitted failed event via the normal runtime bus path

### Requirement: Recovery runs before HTTP server starts

The runtime startup sequence SHALL run `recover()` after consumers initialize but BEFORE the HTTP server binds its port. Triggers MUST NOT receive incoming requests until recovery has completed.

#### Scenario: Recovery completes before port bind

- **WHEN** the runtime starts
- **THEN** the startup sequence SHALL be: storage backend init -> bus + consumers init (EventStore bootstraps from archive) -> workflow registry init -> recover() -> HTTP server bind
- **AND** no request to `/webhooks/*` SHALL be processed before recover() resolves
