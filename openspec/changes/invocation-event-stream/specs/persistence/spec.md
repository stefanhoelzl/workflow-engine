## MODIFIED Requirements

### Requirement: Persistence consumer writes invocation lifecycle records

The persistence consumer SHALL write each `InvocationEvent` as an individual JSON file named `{id}_{seq}.json` in the `pending/` directory. When a terminal event (`trigger.response` or `trigger.error`) is received, the consumer SHALL move all files for that invocation from `pending/` to `archive/{id}/` (renaming to `{seq}.json`).

#### Scenario: Each event writes a pending file
- **WHEN** `handle()` receives any `InvocationEvent`
- **THEN** it SHALL write the event as `pending/{id}_{seq}.json` via the StorageBackend

#### Scenario: Terminal event triggers archive move
- **WHEN** `handle()` receives a `trigger.response` or `trigger.error` event
- **THEN** it SHALL move all `pending/{id}_*.json` files to `archive/{id}/{seq}.json`

#### Scenario: Non-terminal event does not trigger archive
- **WHEN** `handle()` receives a `system.response` or `action.request` event
- **THEN** the event SHALL be written to `pending/` but no archive move SHALL occur

### Requirement: Persistence exposes scan helpers for recovery

`scanPending()` SHALL yield individual `InvocationEvent` objects parsed from `pending/{id}_{seq}.json` files. `scanArchive()` SHALL yield `InvocationEvent` objects parsed from `archive/{id}/{seq}.json` files.

#### Scenario: scanPending yields each pending event
- **WHEN** `scanPending()` is called with files in `pending/`
- **THEN** it SHALL yield each parsed `InvocationEvent`

#### Scenario: scanArchive yields each archived event
- **WHEN** `scanArchive()` is called with directories in `archive/`
- **THEN** it SHALL yield each parsed `InvocationEvent` from all invocation directories
