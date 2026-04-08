## MODIFIED Requirements

### Requirement: handle() writes append-only state files

`handle(event)` SHALL write a new JSON file for every RuntimeEvent received. The write behavior depends on the event state:

- **Non-terminal states** (pending, processing): Write to the `pending/` directory. After writing, initiate fire-and-forget archival of any older files for the same event ID in `pending/`.
- **Terminal states** (done, failed, skipped): Write directly to the `archive/` directory. After writing, initiate fire-and-forget archival of any remaining files for the same event ID in `pending/`.

Files SHALL use the naming pattern `<counter>_evt_<uuid>.json` where counter is a zero-padded 6-digit global monotonic integer.

#### Scenario: Pending event is persisted

- **GIVEN** the current counter is 5
- **WHEN** `handle({ id: "evt_abc", state: "pending", ... })` is called
- **THEN** a file `000006_evt_abc.json` is written to `pending/`
- **AND** no archive operation is initiated (first file for this event)

#### Scenario: Processing event is persisted and older files archived

- **GIVEN** the current counter is 6
- **AND** `pending/` contains `000006_evt_abc.json` with state "pending"
- **WHEN** `handle({ id: "evt_abc", state: "processing", ... })` is called
- **THEN** a file `000007_evt_abc.json` is written to `pending/`
- **AND** archiving of `000006_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Terminal state event is written directly to archive

- **GIVEN** the current counter is 7
- **AND** `pending/` contains `000007_evt_abc.json` with state "processing"
- **WHEN** `handle({ id: "evt_abc", state: "done", ... })` is called
- **THEN** a file `000008_evt_abc.json` is written to `archive/` (not `pending/`)
- **AND** archiving of `000007_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Archive failure is logged but does not throw

- **GIVEN** an archive operation fails
- **WHEN** the background archive runs
- **THEN** the error is logged
- **AND** no exception propagates to the bus

### Requirement: recover() scans filesystem and yields batches

The persistence consumer SHALL expose a `recover()` method that returns an `AsyncIterable<RecoveryBatch>` where `RecoveryBatch` is `{ events: RuntimeEvent[], pending: boolean, finished: boolean }`. It SHALL:

1. Create `pending/` and `archive/` directories if they do not exist
2. Recover the global counter from the maximum counter across both `pending/` and `archive/`
3. Read `pending/` files, group by event ID, take the latest (highest counter) per event, and move older files to `archive/`
4. Yield pending events with `{ pending: true }`
5. Read all `archive/` files
6. Yield archive events with `{ pending: false, finished: true }`
7. If no events exist in either directory, yield an empty batch with `{ pending: true, finished: true }`

#### Scenario: Recover single pending event

- **GIVEN** `pending/` contains `000001_evt_abc.json` with `state: "pending"`
- **AND** `archive/` is empty
- **WHEN** `recover()` is iterated
- **THEN** one batch is yielded with `pending: true`, `finished: true`, containing the event

#### Scenario: Recover handles crash case (2 files per event)

- **GIVEN** `pending/` contains `000001_evt_abc.json` (pending) and `000002_evt_abc.json` (processing)
- **WHEN** `recover()` is iterated
- **THEN** `000001_evt_abc.json` is moved to `archive/`
- **AND** a batch with `pending: true` is yielded containing only the processing event

#### Scenario: Recover yields pending then archive

- **GIVEN** `pending/` contains `000003_evt_active.json` (pending)
- **AND** `archive/` contains `000001_evt_done.json` (pending) and `000002_evt_done.json` (done)
- **WHEN** `recover()` is iterated
- **THEN** the first batch has `pending: true`, `finished: false` with the active event
- **AND** the second batch has `pending: false`, `finished: true` with both archived events

#### Scenario: Counter recovered from max across both directories

- **GIVEN** `archive/` contains `000042_evt_old.json` and `pending/` contains `000043_evt_abc.json`
- **WHEN** `recover()` completes
- **THEN** the next `handle()` call uses counter value 44

#### Scenario: Empty directories

- **GIVEN** both `pending/` and `archive/` are empty
- **WHEN** `recover()` is iterated
- **THEN** one batch is yielded with `events: []`, `pending: true`, `finished: true`
- **AND** the counter starts at 0
