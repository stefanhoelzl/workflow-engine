## ADDED Requirements

### Requirement: Capability deprecated

The `persistence` capability SHALL be considered deprecated and is retained as
a tombstone only. The runtime SHALL NOT write `pending/{id}/{seq}.json` per-event
records or `archive/{id}.json` per-invocation rollups. Durable storage of
invocation events lives in the `event-store` capability, which uses DuckLake
(catalog DB + Parquet files) as its substrate.

#### Scenario: No pending or archive JSON files written

- **GIVEN** a runtime processing invocations against any backend (FS or S3)
- **WHEN** the operator inspects the persistence root
- **THEN** there SHALL NOT be any `pending/` directory
- **AND** there SHALL NOT be any `archive/{id}.json` files

## REMOVED Requirements

### Requirement: Persistence consumer implements BusConsumer

**Reason**: The `persistence` capability is dissolved. Its responsibilities (durable storage of invocation events) move into the rewritten `event-store` capability, which uses DuckLake for durable storage. There is no separate persistence consumer.

**Migration**: Operators wipe legacy `archive/` and `pending/` artefacts before deploying (see `docs/upgrades.md`). Code-side, the `createPersistence(backend)` factory is deleted and `EventStore` takes over all event-storage responsibilities.

### Requirement: Persistence consumer writes invocation lifecycle records

**Reason**: The per-event `pending/{id}/{seq}.json` write and per-invocation `archive/{id}.json` rollup are replaced by DuckLake commit-per-terminal. In-flight events live in RAM only; SIGKILL loses them deliberately.

**Migration**: Remove `pending/` and `archive/{id}.json` writers. Code that previously called `bus.emit(event)` now calls `eventStore.record(event)` which buffers in RAM and commits a single DuckLake transaction on terminal events.

### Requirement: Atomic file writes via StorageBackend

**Reason**: Persistence is no longer the storage layer for events. `StorageBackend.write` is still atomic (FS uses tmp+rename, S3 uses PutObject) and is still used by `workflow-registry` for tarballs and by `EventStore` for the catalog file PUT, but the requirement no longer belongs to the persistence capability.

**Migration**: The atomicity property remains a `storage-backend` capability concern.

### Requirement: Persistence exposes scan helpers for recovery

**Reason**: There is no `pending/` or `archive/` to scan. `scanPending` and `scanArchive` are deleted along with the persistence module.

**Migration**: Remove all imports of `scanPending` / `scanArchive`. The recovery scan path is also deleted (see the `recovery` capability removal).

### Requirement: Pending write failure is fatal

**Reason**: Pending writes do not exist. There is no per-event durability layer to fail.

**Migration**: The bounded retry-then-drop policy on terminal commits replaces this requirement. See "Bounded retry then drop on commit failure" in the rewritten `event-store` capability.
