### Requirement: StorageBackend interface

The system SHALL expose a `StorageBackend` interface with the following methods:
- `init(): Promise<void>` — initialize the backend (create directories, verify access)
- `write(path: string, data: string): Promise<void>` — write data atomically to a path
- `read(path: string): Promise<string>` — read data from a path
- `list(prefix: string): AsyncIterable<string>` — yield all paths under a prefix recursively, one per iteration
- `remove(path: string): Promise<void>` — remove a path
- `move(from: string, to: string): Promise<void>` — move a path from source to destination

Paths SHALL use forward-slash separators (e.g. `events/pending/000001_evt_abc.json`).

#### Scenario: Interface contract

- **GIVEN** a `StorageBackend` implementation
- **WHEN** `write("dir/file.json", "content")` is called followed by `read("dir/file.json")`
- **THEN** `read` SHALL return `"content"`

#### Scenario: List yields matching paths recursively

- **GIVEN** files at `workflows/foo/manifest.json`, `workflows/foo/actions/handle.js`, and `events/pending/001.json`
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL yield `"workflows/foo/manifest.json"` and `"workflows/foo/actions/handle.js"`
- **AND** it SHALL NOT yield `"events/pending/001.json"`

#### Scenario: Move relocates a file

- **GIVEN** a file at `events/pending/a.json`
- **WHEN** `move("events/pending/a.json", "events/archive/a.json")` is called
- **THEN** `read("events/archive/a.json")` SHALL return the original content
- **AND** `list("events/pending/")` SHALL NOT yield `"events/pending/a.json"`

#### Scenario: Remove deletes a file

- **GIVEN** a file at `events/pending/a.json`
- **WHEN** `remove("events/pending/a.json")` is called
- **THEN** `list("events/pending/")` SHALL NOT yield `"events/pending/a.json"`

### Requirement: Filesystem backend

The system SHALL provide a filesystem-backed `StorageBackend` implementation created via a factory function that accepts a root directory path.

- `init` SHALL create the root directory recursively if it does not exist
- `write` SHALL use a write-then-rename pattern (write to `<path>.tmp`, then rename to `<path>`) for atomicity
- `read` SHALL read UTF-8 file content
- `list` SHALL yield paths recursively relative to the root directory using `readdir({ recursive: true })`
- `remove` SHALL delete the file using `fs.unlink`
- `move` SHALL use `fs.rename`

#### Scenario: Atomic write survives crash

- **GIVEN** a filesystem backend
- **WHEN** the process crashes during `write("events/pending/file.json", data)`
- **THEN** either the complete file exists or only a `.tmp` file remains
- **AND** no partial JSON is written to the target path

#### Scenario: Init creates directories

- **GIVEN** a filesystem backend with root `/data/storage`
- **WHEN** `init()` is called
- **THEN** the directory `/data/storage` SHALL exist

#### Scenario: Recursive listing

- **GIVEN** a filesystem backend with files at `workflows/foo/manifest.json` and `workflows/foo/actions/handle.js`
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL yield `"workflows/foo/manifest.json"` and `"workflows/foo/actions/handle.js"`

### Requirement: S3 backend

The system SHALL provide an S3-compatible `StorageBackend` implementation created via a factory function that accepts bucket name, credentials, and optional endpoint/region.

- `init` SHALL verify bucket access via `HeadBucket`
- `write` SHALL use `PutObject` (natively atomic)
- `read` SHALL use `GetObject` and return the body as a UTF-8 string
- `list` SHALL use `ListObjectsV2` with pagination, yielding one key per iteration across page boundaries
- `remove` SHALL use `DeleteObject`
- `move` SHALL use `CopyObject` followed by `DeleteObject` (non-atomic)

The S3 client SHALL be configured with explicit credentials only (access key ID + secret access key). It SHALL NOT use the AWS SDK credential provider chain.

#### Scenario: S3 write and read roundtrip

- **GIVEN** an S3 backend configured with a valid bucket
- **WHEN** `write("pending/file.json", '{"id":"evt_1"}')` is called
- **THEN** `read("pending/file.json")` SHALL return `'{"id":"evt_1"}'`

#### Scenario: S3 list paginates transparently

- **GIVEN** an S3 bucket with more than 1000 keys under `archive/`
- **WHEN** `list("archive/")` is iterated to completion
- **THEN** all keys SHALL be yielded across page boundaries

#### Scenario: S3 init verifies bucket access

- **GIVEN** an S3 backend configured with an invalid bucket name
- **WHEN** `init()` is called
- **THEN** it SHALL throw an error indicating the bucket is not accessible

#### Scenario: S3 with custom endpoint

- **GIVEN** an S3 backend configured with `endpoint: "http://localhost:9000"`
- **WHEN** any operation is called
- **THEN** the S3 client SHALL send requests to the custom endpoint

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

### Requirement: Storage layout with events and workflows prefixes

Event persistence SHALL use `events/pending/` and `events/archive/` prefixes (previously `pending/` and `archive/`). Workflow storage SHALL use `workflows/{name}/` prefix. This is a **BREAKING** change to the storage layout.

#### Scenario: Event written to events prefix

- **WHEN** a pending event is persisted
- **THEN** it SHALL be written to `events/pending/{counter}_evt_{id}.json`

#### Scenario: Event archived to events prefix

- **WHEN** a terminal event is persisted
- **THEN** it SHALL be written to `events/archive/{counter}_evt_{id}.json`

#### Scenario: Workflow stored under workflows prefix

- **WHEN** workflow "foo" is uploaded
- **THEN** its manifest SHALL be stored at `workflows/foo/manifest.json`
- **AND** its action files SHALL be stored at `workflows/foo/actions/{name}.js`
