## MODIFIED Requirements

### Requirement: handle() writes append-only state files

`handle(event)` SHALL write a new JSON file for every RuntimeEvent received. The write behavior depends on the event state:

- **Non-terminal states** (`state: "pending"` or `state: "processing"`): Write to the `pending/` directory. After writing, initiate fire-and-forget archival of any older files for the same event ID in `pending/`.
- **Terminal state** (`state: "done"`): Write directly to the `archive/` directory. After writing, initiate fire-and-forget archival of any remaining files for the same event ID in `pending/`.

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

#### Scenario: Succeeded event is written directly to archive

- **GIVEN** the current counter is 7
- **AND** `pending/` contains `000007_evt_abc.json` with state "processing"
- **WHEN** `handle({ id: "evt_abc", state: "done", result: "succeeded", ... })` is called
- **THEN** a file `000008_evt_abc.json` is written to `archive/` (not `pending/`)
- **AND** archiving of `000007_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Failed event is written directly to archive

- **GIVEN** the current counter is 8
- **AND** `pending/` contains `000008_evt_abc.json` with state "processing"
- **WHEN** `handle({ id: "evt_abc", state: "done", result: "failed", error: "timeout", ... })` is called
- **THEN** a file `000009_evt_abc.json` is written to `archive/` (not `pending/`)
- **AND** archiving of `000008_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Skipped event is written directly to archive

- **GIVEN** the current counter is 9
- **AND** `pending/` contains `000009_evt_abc.json` with state "processing"
- **WHEN** `handle({ id: "evt_abc", state: "done", result: "skipped", ... })` is called
- **THEN** a file `000010_evt_abc.json` is written to `archive/` (not `pending/`)
- **AND** archiving of `000009_evt_abc.json` from `pending/` to `archive/` is initiated (fire-and-forget)

#### Scenario: Archive failure is logged but does not throw

- **GIVEN** an archive operation fails
- **WHEN** the background archive runs
- **THEN** the error is logged
- **AND** no exception propagates to the bus

### Requirement: Fire-and-forget archive on terminal states

When `handle()` receives a RuntimeEvent with `state === "done"`, it SHALL write the terminal state file (awaited), then initiate archiving of all files for that event ID without awaiting. Archive moves files from `pending/` to `archive/` in ascending counter order.

#### Scenario: Archive does not block the bus

- **GIVEN** an event with `state: "done"` and `result: "succeeded"` is emitted to the bus
- **WHEN** persistence's `handle()` is called
- **THEN** the terminal state file write is awaited
- **AND** `handle()` returns before archiving completes
- **AND** archiving proceeds in the background

#### Scenario: Archive failure is logged but does not throw

- **GIVEN** an archive operation fails (e.g., file already moved)
- **WHEN** the background archive runs
- **THEN** the error is logged
- **AND** no exception propagates to the bus
