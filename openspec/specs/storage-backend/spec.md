# Storage Backend Specification

## Purpose

Define the `StorageBackend` interface (FS-backed and S3-backed implementations) that the runtime uses for: tenant bundle persistence under `workflows/<tenant>.tar.gz`, per-invocation pending event files under `pending/<invocationId>/<seq>.json` (live in-flight), and per-invocation sealed archives under `archive/<invocationId>.json` (each a JSON array of every event in seq order). Owns atomicity, path sanitization, and the backend-selection logic driven by `PERSISTENCE_PATH` vs `PERSISTENCE_S3_*` env vars.
## Requirements
### Requirement: StorageBackend interface

The system SHALL expose a `StorageBackend` interface with the following methods:
- `init(): Promise<void>` — initialize the backend (create directories, verify access)
- `write(path: string, data: Uint8Array): Promise<void>` — write raw bytes atomically to a path
- `read(path: string): Promise<Uint8Array>` — read raw bytes from a path
- `list(prefix: string): AsyncIterable<string>` — yield all paths under a prefix recursively, one per iteration
- `locator(): StorageLocator` — return the backend's concrete connection so consumers (notably EventStore) can configure direct-access libraries (notably the DuckLake DuckDB extension) without re-parsing config envs

`StorageLocator` SHALL be a discriminated union:

```ts
type StorageLocator =
  | { kind: "fs"; root: string }
  | { kind: "s3";
      bucket: string;
      endpoint: string;
      region: string;
      accessKeyId: Secret;
      secretAccessKey: Secret;
      urlStyle: "path" | "virtual";
      useSsl: boolean }
```

`Secret` SHALL be the runtime's secret-wrapper type. Consumers SHALL call `Secret.reveal()` only at the boundary where the value is consumed (e.g. composing a DuckDB `CREATE SECRET` statement) and SHALL NOT log the revealed value.

There SHALL NOT be string-variant `read`/`write` methods, nor `remove`, `removePrefix`, or `move` methods on the interface — the only callers of those methods (the persistence consumer, the recovery scan path, the health sentinel, and `scripts/prune-legacy-storage.ts`) are deleted as part of this change. Path separators SHALL still be forward slashes.

#### Scenario: Byte-level write and read roundtrip

- **GIVEN** a `StorageBackend` implementation
- **AND** a `Uint8Array` containing arbitrary binary bytes (e.g. a gzip header `0x1f 0x8b 0x08 0x00`)
- **WHEN** `write("workflows/foo/bar/abc.tar.gz", data)` is called followed by `read("workflows/foo/bar/abc.tar.gz")`
- **THEN** `read` SHALL return a `Uint8Array` whose byte contents are identical to `data`

#### Scenario: List yields matching paths recursively

- **GIVEN** files at `workflows/foo/bar/abc.tar.gz` and `events.duckdb`
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL yield `"workflows/foo/bar/abc.tar.gz"`
- **AND** it SHALL NOT yield `"events.duckdb"`

#### Scenario: FS locator returns the absolute root path

- **GIVEN** a filesystem backend constructed with root `/var/lib/wfe`
- **WHEN** `locator()` is called
- **THEN** it SHALL return `{ kind: "fs", root: "/var/lib/wfe" }`

#### Scenario: S3 locator returns the bucket and credential block

- **GIVEN** an S3 backend constructed with bucket `wfe`, endpoint `s2.local:9000`, region `auto`, path-style URLs, TLS on
- **WHEN** `locator()` is called
- **THEN** it SHALL return `{ kind: "s3", bucket: "wfe", endpoint: "s2.local:9000", region: "auto", accessKeyId: <Secret>, secretAccessKey: <Secret>, urlStyle: "path", useSsl: true }`
- **AND** the `accessKeyId` and `secretAccessKey` SHALL be `Secret`-wrapped (not plain strings)

### Requirement: Filesystem backend

The system SHALL provide a filesystem-backed `StorageBackend` implementation created via a factory function that accepts a root directory path.

- `init` SHALL create the root directory recursively if it does not exist
- `write` SHALL use a write-then-rename pattern (write to `<path>.tmp`, then rename to `<path>`) for atomicity and SHALL persist the `Uint8Array` without any encoding transformation
- `read` SHALL read the file as raw bytes and return a `Uint8Array` over its contents
- `list` SHALL yield paths recursively relative to the root directory
- `locator` SHALL return `{ kind: "fs", root: <absolute-root-path> }`

#### Scenario: Atomic write survives crash

- **GIVEN** a filesystem backend
- **WHEN** the process crashes after `writeFile(<tmp>)` but before `rename(<tmp>, <path>)` completes
- **THEN** the destination path SHALL either contain the previous content or not exist (never partial content)

#### Scenario: Filesystem locator integrates with EventStore

- **GIVEN** a filesystem backend rooted at `/var/lib/wfe`
- **WHEN** EventStore calls `backend.locator()` and composes its DuckLake `ATTACH` statement
- **THEN** EventStore SHALL ATTACH `'ducklake:/var/lib/wfe/events.duckdb'` with `DATA_PATH '/var/lib/wfe/events/'`

### Requirement: S3 backend

The system SHALL provide an S3-backed `StorageBackend` implementation that conforms to the same interface as the filesystem backend.

- `init` SHALL verify access to the bucket (e.g. `HeadBucket`) and SHALL throw if the bucket is not reachable or not authorised
- `write` SHALL use `PutObject` with the `Uint8Array` as the body — no `If-Match` header (see the `event-store` capability for the rationale)
- `read` SHALL use `GetObject` and return the body as a `Uint8Array`
- `list` SHALL use `ListObjectsV2` with continuation tokens and yield each key as a string
- `locator` SHALL return the full S3 connection block including bucket, endpoint, region, credentials (as `Secret`s), URL style, and TLS flag

#### Scenario: S3 locator integrates with EventStore SECRET creation

- **GIVEN** an S3 backend whose `locator()` returns `{ kind: "s3", bucket: "wfe", endpoint: "s2.local:9000", region: "auto", accessKeyId, secretAccessKey, urlStyle: "path", useSsl: true }`
- **WHEN** EventStore initialises against that backend
- **THEN** EventStore SHALL run `CREATE SECRET (TYPE S3, KEY_ID '…', SECRET '…', REGION 'auto', ENDPOINT 's2.local:9000', URL_STYLE 'path', USE_SSL 'true')`
- **AND** the revealed secret values SHALL appear only in the SQL statement composition site, not in any log line

### Requirement: StorageBackend factory

The system SHALL provide a `createStorageBackend` factory function that accepts a config object and returns the appropriate `StorageBackend` implementation.

- If `persistencePath` is set, it SHALL return a filesystem backend rooted at that path
- If `persistenceS3Bucket` is set, it SHALL return an S3 backend configured with the S3 env vars
- If neither is set, it SHALL return `undefined`

#### Scenario: Factory creates FS backend

- **WHEN** `createStorageBackend` is called with `{ persistencePath: "/data/events" }`
- **THEN** it SHALL return a filesystem `StorageBackend` rooted at `/data/events`

#### Scenario: Factory creates S3 backend

- **WHEN** `createStorageBackend` is called with `{ persistenceS3Bucket: "my-bucket", persistenceS3AccessKeyId: "key", persistenceS3SecretAccessKey: "secret" }`
- **THEN** it SHALL return an S3 `StorageBackend` configured for `my-bucket`

#### Scenario: Factory returns undefined when no persistence configured

- **WHEN** `createStorageBackend` is called with `{}`
- **THEN** it SHALL return `undefined`

### Requirement: Storage layout

The runtime's persistence root SHALL contain three top-level entries used by different consumers:

- `events.duckdb` — the DuckLake catalog (owned by EventStore).
- `events/main/events/owner=<owner>/repo=<repo>/...parquet` — DuckLake data files (managed by DuckLake; the `main/events/` segment is DuckLake's `<schema>/<table>` nesting beneath the configured `DATA_PATH`).
- `workflows/<owner>/<repo>/<sha>.tar.gz` — workflow tarballs (owned by `workflow-registry`).

There SHALL NOT be `pending/` or `archive/{id}.json` entries. Operators wipe any pre-existing legacy entries before deploying this change (see `docs/upgrades.md`).

#### Scenario: Layout under FS backend

- **GIVEN** an FS backend with root `/var/lib/wfe`
- **AND** EventStore has committed at least one terminal invocation under `(acme, foo)`
- **AND** workflow-registry has stored at least one bundle for `(acme, foo, sha1)`
- **WHEN** the layout is inspected
- **THEN** `/var/lib/wfe/events.duckdb` SHALL exist
- **AND** `/var/lib/wfe/events/main/events/owner=acme/repo=foo/` SHALL contain at least one Parquet file (after a CHECKPOINT has flushed inlined rows)
- **AND** `/var/lib/wfe/workflows/acme/foo/sha1.tar.gz` SHALL exist
- **AND** `/var/lib/wfe/pending/` and `/var/lib/wfe/archive/` SHALL NOT exist

