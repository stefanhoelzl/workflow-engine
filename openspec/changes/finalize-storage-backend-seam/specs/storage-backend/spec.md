## MODIFIED Requirements

### Requirement: StorageBackend interface

The system SHALL expose a `StorageBackend` interface with the following data methods:
- `write(path: string, data: Uint8Array): Promise<void>` — write raw bytes atomically to a path
- `read(path: string): Promise<Uint8Array>` — read raw bytes from a path; SHALL throw `NotFoundError` if the path does not exist
- `list(prefix: string): AsyncIterable<string>` — yield all committed paths under a prefix recursively, one per iteration

The interface SHALL NOT declare an `init()` method: a backend is initialized by its async factory at construction time (see "StorageBackend factory"), so a constructed `StorageBackend` is always ready for use.

The interface SHALL NOT expose a `locator()` method or any `StorageLocator` type. EventStore and QueueStore own their libSQL connection directly (constructed from `DATABASE_URL`); they do not obtain a connection descriptor from the storage backend. The storage backend is solely a bytes store for tenant bundles.

There SHALL NOT be string-variant `read`/`write` methods, nor `remove`, `removePrefix`, or `move` methods on the interface. Keys SHALL be treated as opaque forward-slash-delimited strings.

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

#### Scenario: Interface has no init method

- **WHEN** the `StorageBackend` type is inspected
- **THEN** it SHALL expose exactly `write`, `read`, and `list`
- **AND** it SHALL NOT expose an `init` method

### Requirement: Filesystem backend

The system SHALL provide a filesystem-backed `StorageBackend` implementation created via an async factory function that accepts a root directory path and returns an already-initialized backend.

- The factory SHALL create the root directory recursively (if it does not exist) during construction; there is no separate `init` step
- `write` SHALL use a write-then-rename pattern (write to `<path>.tmp`, then rename to `<path>`) for atomicity and SHALL persist the `Uint8Array` without any encoding transformation
- `read` SHALL read the file as raw bytes and return a `Uint8Array` over its contents; on `ENOENT` it SHALL throw `NotFoundError`
- `list` SHALL yield committed paths recursively relative to the root directory and SHALL exclude `*.tmp` write-staging artifacts

#### Scenario: Atomic write survives crash

- **GIVEN** a filesystem backend
- **WHEN** the process crashes after `writeFile(<tmp>)` but before `rename(<tmp>, <path>)` completes
- **THEN** the destination path SHALL either contain the previous content or not exist (never partial content)

#### Scenario: list excludes in-progress tmp artifacts

- **GIVEN** a filesystem backend whose root contains a leftover `workflows/foo/bar.tar.gz.tmp` from a crashed write
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL NOT yield any path ending in `.tmp`

#### Scenario: read of a missing path throws NotFoundError

- **GIVEN** a filesystem backend with no object at `workflows/none/missing.tar.gz`
- **WHEN** `read("workflows/none/missing.tar.gz")` is awaited
- **THEN** it SHALL reject with a `NotFoundError`

### Requirement: StorageBackend factory

The runtime SHALL construct its `StorageBackend` via an async `createStorage(config)` factory that selects the implementation by `config.storageBackend` (sourced from the `STORAGE_BACKEND` env var; see the `runtime-config` capability). For `"fs"` it SHALL return `await createFsStorage(config.persistencePath)` — the filesystem backend rooted at `PERSISTENCE_PATH`. The factory SHALL reject (fail fast at boot) when `config.storageBackend` is an unrecognised value. `"fs"` is the only registered backend today; a future remote backend (e.g. S3, Bunny) is added as an additional case in this factory without changing any call site. The filesystem factory `createFsStorage(path)` remains the fs implementation invoked by `createStorage`.

#### Scenario: FS backend constructed from PERSISTENCE_PATH

- **WHEN** the runtime starts with `STORAGE_BACKEND` unset (defaulting to `"fs"`) and `PERSISTENCE_PATH=/data/events`
- **THEN** `createStorage(config)` SHALL resolve to a filesystem `StorageBackend` rooted at `/data/events`

#### Scenario: Unknown backend value fails fast

- **WHEN** the runtime starts with `STORAGE_BACKEND=s3`
- **THEN** `createStorage(config)` SHALL reject with an error identifying the unrecognised backend
- **AND** the runtime SHALL NOT begin serving

## ADDED Requirements

### Requirement: NotFoundError read-miss contract

The system SHALL define a `NotFoundError` type that `StorageBackend.read` throws when the requested key does not exist. Every backend implementation SHALL map its native miss signal (filesystem `ENOENT`, object-store HTTP 404) to `NotFoundError` so callers branch on a single backend-agnostic type. Callers that read a key which may legitimately be absent SHALL handle `NotFoundError` explicitly.

#### Scenario: Registry recovery tolerates a vanished key

- **GIVEN** `WorkflowRegistry.recover()` has listed `workflows/acme/foo.tar.gz`
- **AND** the object is deleted before `recover()` reads it
- **WHEN** `read("workflows/acme/foo.tar.gz")` throws `NotFoundError`
- **THEN** `recover()` SHALL log and skip that key rather than crashing
- **AND** recovery of the remaining keys SHALL continue

### Requirement: Future remote-backend contract

Any future `StorageBackend` implementation (e.g. S3, Bunny) SHALL satisfy a backend-agnostic contract so it is a drop-in addition behind `createStorage`:

- `write(path, data)` SHALL replace the object at `path` atomically — a concurrent or subsequent `read` SHALL observe either the complete prior bytes or the complete new bytes, never a partial object.
- `read(path)` SHALL return the exact bytes last written, and SHALL throw `NotFoundError` when no object exists at `path`.
- `list(prefix)` SHALL yield every committed key whose string begins with `prefix`, recursively, and SHALL NOT yield write-staging artifacts. List order is unspecified; callers SHALL NOT depend on it.
- Keys SHALL be treated as opaque forward-slash-delimited strings with no leading slash; the backend SHALL NOT reinterpret them as OS-native paths.

#### Scenario: A conforming backend is selectable without further wiring

- **GIVEN** a hypothetical backend that satisfies this contract and is registered in `createStorage` under a `STORAGE_BACKEND` value
- **WHEN** the runtime starts with that value
- **THEN** `WorkflowRegistry` recovery and upload SHALL operate against it unchanged (no call-site edits)

### Requirement: Backend conformance suite

The repository SHALL provide a backend-agnostic conformance test suite that exercises the `StorageBackend` contract against a supplied implementation, and SHALL run it against the filesystem backend. The suite SHALL cover: byte-level write/read roundtrip, recursive `list` over a prefix, exclusion of non-matching and `.tmp` keys from `list`, `NotFoundError` on read of a missing key, and atomic replacement on overwrite.

#### Scenario: Filesystem backend passes the conformance suite

- **WHEN** the conformance suite is run against `createFsStorage`
- **THEN** every contract assertion SHALL pass
