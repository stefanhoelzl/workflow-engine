## MODIFIED Requirements

### Requirement: bootstrap() buffers pending and processing events

`bootstrap(events, options)` SHALL buffer events with state `"pending"` or `"processing"`. Events with terminal states (done/failed/skipped) SHALL be ignored. Processing events are included because they represent work interrupted by a crash that needs retry.

When `options.pending` is `false`, the bootstrap call SHALL be skipped entirely (no events buffered). These are historical archive events that have already been processed.

When `options.pending` is `true` or `undefined`, events are buffered directly — no deduplication is needed since `pending/` contains at most one file per event.

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

#### Scenario: Bootstrap skips archive batches

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{id: "evt_1", state: "pending"}], { pending: false })` is called
- **THEN** no events are buffered

#### Scenario: Bootstrap buffers from pending batches

- **GIVEN** a WorkQueue
- **WHEN** `bootstrap([{id: "evt_a", state: "pending"}, {id: "evt_b", state: "processing"}, {id: "evt_c", state: "done"}], { pending: true })` is called
- **THEN** evt_a and evt_b are buffered
- **AND** evt_c is ignored (terminal state)
