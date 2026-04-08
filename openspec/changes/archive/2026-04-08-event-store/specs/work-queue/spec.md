## MODIFIED Requirements

### Requirement: bootstrap() buffers pending and processing events

`bootstrap(events, options)` SHALL buffer events with state `"pending"` or `"processing"`. Events with terminal states (done/failed/skipped) SHALL be ignored. Processing events are included because they represent work interrupted by a crash that needs retry.

When `options.latest` is `false`, the bootstrap call SHALL be skipped entirely (no events buffered). When `options.latest` is `true`, the consumer SHALL deduplicate events by event ID, keeping only the most recent state per event (based on array position — last occurrence wins), then buffer only those with state `"pending"` or `"processing"`.

When `options.latest` is `undefined` (backwards-compatible default), behavior is unchanged: buffer all pending/processing events without deduplication.

#### Scenario: Bootstrap buffers pending events

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{state: "pending"}, {state: "done"}])` is called without options
- **THEN** only the pending event is buffered

#### Scenario: Bootstrap buffers processing events for retry

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{state: "processing"}])` is called without options
- **THEN** the processing event is buffered

#### Scenario: Bootstrap ignores terminal events

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{state: "done"}, {state: "failed"}, {state: "skipped"}])` is called
- **THEN** no events are buffered

#### Scenario: Bootstrap skips non-latest batches

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{id: "evt_1", state: "pending"}, {id: "evt_2", state: "processing"}], { latest: false })` is called
- **THEN** no events are buffered

#### Scenario: Bootstrap deduplicates on latest batches

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{id: "evt_1", state: "pending"}, {id: "evt_1", state: "processing"}], { latest: true })` is called
- **THEN** only one event is buffered: evt_1 with state "processing" (last occurrence wins)

#### Scenario: Bootstrap latest filters after dedup

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{id: "evt_1", state: "pending"}, {id: "evt_1", state: "done"}], { latest: true })` is called
- **THEN** no events are buffered (evt_1's latest state is "done", which is terminal)
