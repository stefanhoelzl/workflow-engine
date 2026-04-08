## MODIFIED Requirements

### Requirement: recover() scans filesystem and yields batches

The persistence consumer SHALL expose a `recover()` method that returns an `AsyncIterable<{ events: RuntimeEvent[], latest: boolean }>`. It SHALL:
1. Create `pending/` and `archive/` directories if they do not exist
2. Read all `*.json` files from BOTH `pending/` AND `archive/` directories
3. Group files by event ID
4. For each event group, identify the file with the highest counter as the "latest" state
5. Recover the global counter from the maximum counter across both directories
6. Yield non-latest events (intermediate state transitions) in batches with `latest: false`
7. Yield latest events (current state per event, deduplicated) in a batch with `latest: true`
8. For events whose latest state is terminal (done/failed/skipped) and whose files remain in `pending/`, complete the archive (move files to `archive/`)

#### Scenario: Recover yields all events in two phases

- **GIVEN** `pending/` contains `000001_evt_abc.json` (pending) and `000002_evt_abc.json` (processing)
- **AND** `archive/` contains `000003_evt_def.json` (pending), `000004_evt_def.json` (processing), and `000005_evt_def.json` (done)
- **WHEN** `recover()` is iterated
- **THEN** a batch with `latest: false` is yielded containing: evt_abc/pending, evt_def/pending, evt_def/processing
- **AND** a batch with `latest: true` is yielded containing: evt_abc/processing, evt_def/done

#### Scenario: Recover pending events from both directories

- **GIVEN** `pending/` contains `000001_evt_abc.json` with `state: "pending"`
- **AND** `archive/` contains `000010_evt_xyz.json` with `state: "done"`
- **WHEN** `recover()` is iterated
- **THEN** both events appear across the yielded batches

#### Scenario: Complete interrupted archive during recovery

- **GIVEN** `pending/` contains `000001_evt_abc.json` (pending) and `000005_evt_abc.json` (done)
- **WHEN** `recover()` is iterated
- **THEN** both files are moved to `archive/`
- **AND** the events are still yielded (evt_abc/pending as non-latest, evt_abc/done as latest)

#### Scenario: Counter recovered from max across both directories

- **GIVEN** `archive/` contains `000042_evt_old.json` and `pending/` contains `000043_evt_abc.json`
- **WHEN** `recover()` completes
- **THEN** the next `handle()` call uses counter value 44

#### Scenario: Empty directories

- **GIVEN** both `pending/` and `archive/` are empty (or do not exist)
- **WHEN** `recover()` is iterated
- **THEN** no batches are yielded
- **AND** the counter starts at 0
