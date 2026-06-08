## ADDED Requirements

### Requirement: Time-based retention prune

EventStore SHALL expose a public `prune({ olderThan })` method that deletes aged invocations and returns the number of invocations deleted. `olderThan` is a wall-clock cutoff. `prune` SHALL delete an invocation only when **every** event sharing its `id` is older than the cutoff, evaluated as `max("at") < olderThan` grouped by `id`, so an invocation's call graph is never partially deleted. The cutoff SHALL be compared against the `at` column (TIMESTAMPTZ wall-clock), NOT `ts` (which is a monotonic value not comparable to wall-clock time).

The deletion SHALL run as a single statement on the EventStore's single read-write connection, serialized with commits so a prune and a commit never execute concurrently on the connection. After deleting, `prune` SHALL issue a `CHECKPOINT` so freed blocks return to DuckDB's reusable free list and the WAL is flushed.

`prune` SHALL NOT shrink the `events.duckdb` file on disk — DuckDB reuses freed space for subsequent writes, so the file plateaus at its high-water mark rather than returning space to the OS. Reclaiming already-consumed disk is an out-of-band operator action, not part of `prune`.

#### Scenario: Prune deletes only fully-aged invocations

- **GIVEN** invocation `evt_old` whose every event has `at` older than the cutoff
- **AND** invocation `evt_recent` with at least one event at or newer than the cutoff
- **WHEN** `prune({ olderThan: cutoff })` is awaited
- **THEN** `query()` SHALL NOT return any rows for `evt_old`
- **AND** `query()` SHALL still return all rows for `evt_recent`
- **AND** `prune` SHALL return a count of `1`

#### Scenario: Prune keeps a straddling call graph whole

- **GIVEN** invocation `evt_span` with an early event older than the cutoff and a later event newer than the cutoff
- **WHEN** `prune({ olderThan: cutoff })` is awaited
- **THEN** all rows for `evt_span` SHALL remain (the invocation's `max("at")` is newer than the cutoff)

#### Scenario: Prune is exposed on the factory result

- **WHEN** `createEventStore(...)` resolves
- **THEN** the returned object SHALL expose `prune` alongside `record`, `query`, `hasUploadEvent`, `ping`, and `drainAndClose`

### Requirement: EventStore self-schedules retention pruning

The EventStore SHALL own retention scheduling internally; there SHALL NOT be a separate retention service. When `config.retentionDays` is greater than `0`, the factory SHALL start a recurring timer that prunes invocations older than `retentionDays`. The prune interval SHALL be derived from the window — the EventStore prunes 100 times per window, i.e. every `retentionDays / 100` days (`retentionDays * 864_000` ms, floored, minimum 1 ms). There SHALL NOT be a separate interval configuration value. When `config.retentionDays` is `0` or unset, the EventStore SHALL NOT schedule any pruning.

The factory SHALL NOT await the first prune before resolving — the first prune SHALL be deferred so it does not delay factory resolution, startup recovery, or HTTP server bind. Each scheduled prune SHALL compute its cutoff as the current wall-clock time minus `retentionDays`.

A scheduled prune that fails SHALL be caught, SHALL log `event-store.prune-failed { error }` at error level, and SHALL NOT propagate — the runtime SHALL NOT exit because a prune failed. The next interval tick is the retry; there is no inner retry loop. A scheduled prune that succeeds SHALL log `event-store.prune-ok { invocations, durationMs }`.

#### Scenario: Retention disabled by default

- **GIVEN** `config.retentionDays` is `0` or unset
- **WHEN** `createEventStore(...)` resolves
- **THEN** no retention timer SHALL be scheduled
- **AND** no invocation SHALL be deleted on any timer

#### Scenario: Scheduled prune runs on the derived interval

- **GIVEN** `config.retentionDays` is `30` (interval derived as `30 / 100` days)
- **AND** the store contains invocations older than 30 days
- **WHEN** a scheduled prune tick fires
- **THEN** invocations older than the cutoff SHALL be deleted
- **AND** an `event-store.prune-ok { invocations, durationMs }` log line SHALL have been emitted

#### Scenario: Scheduled prune failure does not crash the runtime

- **GIVEN** retention is enabled and a scheduled prune fails (e.g. transient I/O error or full disk)
- **WHEN** the prune tick runs
- **THEN** an `event-store.prune-failed { error }` log line SHALL have been emitted
- **AND** the runtime process SHALL still be running
- **AND** the timer SHALL remain scheduled so the next tick retries

## MODIFIED Requirements

### Requirement: SIGTERM drain commits in-flight invocations

On SIGTERM, EventStore SHALL drain in-flight invocations within `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` (default 60 000 ms). Before draining, `drainAndClose` SHALL clear the retention timer (if one was scheduled) so that no new prune starts during shutdown. For each invocation in the accumulator, EventStore SHALL synthesise a terminal `trigger.error { reason: "shutdown" }` event with the next seq number, append it to the accumulator, and commit. After all accumulator entries are drained or the timeout elapses, EventStore SHALL close the DuckDB connection and resolve.

`drainAndClose` SHALL NOT add prune execution time to the drain budget: it guarantees no *new* prune starts once shutting down, but a prune already in flight that does not finish before process exit is cut off by the exit. Because each prune is a single atomic DELETE, an interrupted prune rolls back on next open with no partial deletion, and is retried on the next boot's schedule.

`EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` MUST be less than the systemd `TimeoutStopSec` of the Quadlet unit; otherwise the unit is killed mid-drain. The Quadlet template owns `TimeoutStopSec`; the runtime owns the drain timeout. See the `infrastructure` capability for the unit-side timeout.

If the timeout elapses before all invocations are drained, the remaining in-flight invocations are lost (same outcome as SIGKILL for those entries). EventStore SHALL log `event-store.sigterm-drain-timeout { remaining }` in that case.

#### Scenario: Graceful drain commits each in-flight as trigger.error{shutdown}

- **GIVEN** EventStore's accumulator holds non-terminal events for `evt_a` and `evt_b`
- **WHEN** SIGTERM is delivered and the drain runs to completion within the timeout
- **THEN** the events table SHALL contain a `trigger.error { reason: "shutdown" }` terminal row for both `evt_a` and `evt_b`
- **AND** the accumulator SHALL be empty
- **AND** the DuckDB connection SHALL be closed

#### Scenario: Drain timeout logs and drops the remaining

- **GIVEN** EventStore's accumulator holds 1000 entries
- **AND** `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` is 100 ms (insufficient)
- **WHEN** SIGTERM triggers the drain
- **THEN** as many entries as the timeout permits SHALL be committed
- **AND** an `event-store.sigterm-drain-timeout { remaining }` log line SHALL have been emitted naming the unflushed count

#### Scenario: Drain clears the retention timer

- **GIVEN** retention is enabled (a retention timer is scheduled)
- **WHEN** `drainAndClose` is invoked
- **THEN** the retention timer SHALL be cleared before the drain proceeds
- **AND** no new prune SHALL start after `drainAndClose` is invoked
