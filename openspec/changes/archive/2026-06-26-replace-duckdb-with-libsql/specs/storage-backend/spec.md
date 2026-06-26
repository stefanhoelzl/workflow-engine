## MODIFIED Requirements

### Requirement: StorageBackend interface

The system SHALL expose a `StorageBackend` interface with the following methods:
- `init(): Promise<void>` — initialize the backend (create directories, verify access)
- `write(path: string, data: Uint8Array): Promise<void>` — write raw bytes atomically to a path
- `read(path: string): Promise<Uint8Array>` — read raw bytes from a path
- `list(prefix: string): AsyncIterable<string>` — yield all paths under a prefix recursively, one per iteration

The interface SHALL NOT expose a `locator()` method or any `StorageLocator` type. EventStore and QueueStore own their libSQL connection directly (constructed from `PERSISTENCE_PATH`); they do not obtain a connection descriptor from the storage backend. The storage backend is solely a bytes store for tenant bundles.

There SHALL NOT be string-variant `read`/`write` methods, nor `remove`, `removePrefix`, or `move` methods on the interface. Path separators SHALL be forward slashes.

#### Scenario: Byte-level write and read roundtrip

- **GIVEN** a `StorageBackend` implementation
- **AND** a `Uint8Array` containing arbitrary binary bytes (e.g. a gzip header `0x1f 0x8b 0x08 0x00`)
- **WHEN** `write("workflows/foo/bar/abc.tar.gz", data)` is called followed by `read("workflows/foo/bar/abc.tar.gz")`
- **THEN** `read` SHALL return a `Uint8Array` whose byte contents are identical to `data`

#### Scenario: List yields matching paths recursively

- **GIVEN** files at `workflows/foo/bar/abc.tar.gz` and `events.db`
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL yield `"workflows/foo/bar/abc.tar.gz"`
- **AND** it SHALL NOT yield `"events.db"`

### Requirement: StorageBackend factory

The runtime SHALL provide a filesystem storage factory, `createFsStorage(path)`, that returns an FS-backed `StorageBackend` rooted at `path`. There SHALL NOT be an S3 branch or a multi-backend selector — local disk is the only backend.

#### Scenario: Factory creates an FS backend

- **WHEN** `createFsStorage("/data/events")` is called
- **THEN** it SHALL return a filesystem `StorageBackend` rooted at `/data/events`

### Requirement: Storage layout

The runtime's persistence root SHALL contain two kinds of entries used by different consumers:

- `events.db` — the libSQL database file (owned by EventStore + QueueStore; holds the `events` and `queue_items` tables).
- `workflows/<owner>/<repo>/<sha>.tar.gz` — workflow tarballs (owned by `workflow-registry`).

There SHALL NOT be a DuckDB file (`events.duckdb`), a Parquet directory (`events/`), a lakehouse catalog, or `pending/` / `archive/{id}.json` entries. Operators wipe any pre-existing legacy entries before deploying this change (see `docs/upgrades.md`).

#### Scenario: Layout under FS backend

- **GIVEN** an FS backend with root `/var/lib/wfe`
- **AND** EventStore has committed at least one terminal invocation under `(acme, foo)`
- **AND** workflow-registry has stored at least one bundle for `(acme, foo, sha1)`
- **WHEN** the layout is inspected
- **THEN** `/var/lib/wfe/events.db` SHALL exist
- **AND** `/var/lib/wfe/workflows/acme/foo/sha1.tar.gz` SHALL exist
- **AND** `/var/lib/wfe/events.duckdb`, `/var/lib/wfe/events/`, `/var/lib/wfe/pending/`, and `/var/lib/wfe/archive/` SHALL NOT exist

## REMOVED Requirements

### Requirement: S3 backend

**Reason**: No S3 backend exists in code — the runtime ships only the filesystem backend (`createFsStorage`). The S3 implementation was specced but never built, and the libSQL store does not need object storage.

**Migration**: None. Use the filesystem backend via `PERSISTENCE_PATH`. Durable off-host storage for the SQL data is provided later by the remote libSQL (Bunny) backend, not by an S3 storage backend.
