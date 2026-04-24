# Storage Backend Specification

## Purpose

Define the `StorageBackend` interface (FS-backed and S3-backed implementations) that the runtime uses for: tenant bundle persistence under `workflows/<tenant>.tar.gz`, per-invocation pending event files under `pending/<invocationId>/<seq>.json` (live in-flight), and per-invocation sealed archives under `archive/<invocationId>.json` (each a JSON array of every event in seq order). Owns atomicity, path sanitization, and the backend-selection logic driven by `PERSISTENCE_PATH` vs `PERSISTENCE_S3_*` env vars.

## Requirements

### Requirement: StorageBackend interface

The system SHALL expose a `StorageBackend` interface with the following methods:
- `init(): Promise<void>` — initialize the backend (create directories, verify access)
- `write(path: string, data: string): Promise<void>` — write string data atomically to a path (UTF-8 encoded internally)
- `writeBytes(path: string, data: Uint8Array): Promise<void>` — write raw bytes atomically to a path (for binary payloads such as workflow bundles)
- `read(path: string): Promise<string>` — read data from a path as a UTF-8 string
- `readBytes(path: string): Promise<Uint8Array>` — read raw bytes from a path
- `list(prefix: string): AsyncIterable<string>` — yield all paths under a prefix recursively, one per iteration
- `remove(path: string): Promise<void>` — remove a path
- `removePrefix(prefix: string): Promise<void>` — remove every key/file under a prefix (best-effort; see dedicated requirement)
- `move(from: string, to: string): Promise<void>` — move a path from source to destination

The string `write`/`read` methods SHALL use UTF-8 encoding internally; callers needing any other encoding or binary payloads SHALL use `writeBytes`/`readBytes`.

Paths SHALL use forward-slash separators (e.g. `pending/evt_abc/000001.json`).

#### Scenario: Interface contract

- **GIVEN** a `StorageBackend` implementation
- **WHEN** `write("dir/file.json", "content")` is called followed by `read("dir/file.json")`
- **THEN** `read` SHALL return `"content"`

#### Scenario: Byte-level write and read roundtrip

- **GIVEN** a `StorageBackend` implementation
- **AND** a `Uint8Array` containing arbitrary binary bytes (e.g. a gzip header `0x1f 0x8b 0x08 0x00`)
- **WHEN** `writeBytes("bundles/foo.tar.gz", data)` is called followed by `readBytes("bundles/foo.tar.gz")`
- **THEN** `readBytes` SHALL return a `Uint8Array` whose byte contents are identical to `data`

#### Scenario: String write uses UTF-8 encoding

- **GIVEN** a `StorageBackend` implementation
- **WHEN** `write("dir/file.txt", "héllo")` is called followed by `readBytes("dir/file.txt")`
- **THEN** `readBytes` SHALL return the UTF-8 byte sequence of `"héllo"` (`0x68 0xc3 0xa9 0x6c 0x6c 0x6f`)

#### Scenario: List yields matching paths recursively

- **GIVEN** files at `workflows/foo.tar.gz`, `pending/evt_a/000000.json`, and `archive/evt_a.json`
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL yield `"workflows/foo.tar.gz"`
- **AND** it SHALL NOT yield `"pending/evt_a/000000.json"` or `"archive/evt_a.json"`

#### Scenario: Move relocates a file

- **GIVEN** a file at `pending/a.json`
- **WHEN** `move("pending/a.json", "archive/a.json")` is called
- **THEN** `read("archive/a.json")` SHALL return the original content
- **AND** `list("pending/")` SHALL NOT yield `"pending/a.json"`

#### Scenario: Remove deletes a file

- **GIVEN** a file at `pending/a.json`
- **WHEN** `remove("pending/a.json")` is called
- **THEN** `list("pending/")` SHALL NOT yield `"pending/a.json"`

### Requirement: removePrefix method

The `StorageBackend` interface SHALL expose a `removePrefix(prefix: string): Promise<void>` method that removes every key or file under the given prefix.

`removePrefix` SHALL be best-effort: it SHALL log per-key failures via an injected logger and SHALL NOT reject the returned promise on partial failure. It SHALL be idempotent — calling `removePrefix` on a non-existent or already-cleared prefix SHALL succeed without error.

- The filesystem backend SHALL implement `removePrefix` by calling `fs.rm(path, { recursive: true, force: true })` on the directory corresponding to the prefix. Missing directories SHALL be treated as success.
- The S3 backend SHALL implement `removePrefix` by issuing `ListObjectsV2 { Prefix, ContinuationToken }` in a loop, and for each returned page calling `DeleteObjects` with the listed keys. The loop SHALL continue until `ListObjectsV2` returns no `NextContinuationToken`.

`removePrefix` SHALL make no guarantees under concurrent writes: if another writer adds keys under the prefix between successive `ListObjectsV2` and `DeleteObjects` calls, those keys may survive. Callers SHALL ensure no concurrent writes to the prefix during cleanup.

#### Scenario: Filesystem removePrefix removes all nested files

- **GIVEN** files at `pending/evt_a/000000.json`, `pending/evt_a/000001.json`, and `pending/evt_b/000000.json` exist
- **WHEN** `removePrefix("pending/evt_a/")` is called on the FS backend
- **THEN** no file under `pending/evt_a/` SHALL remain
- **AND** `pending/evt_b/000000.json` SHALL still exist

#### Scenario: S3 removePrefix paginates through large key sets

- **GIVEN** an S3 bucket with 2500 keys under `pending/evt_big/`
- **WHEN** `removePrefix("pending/evt_big/")` is called
- **THEN** the backend SHALL issue multiple `ListObjectsV2` requests paginated via `ContinuationToken`
- **AND** SHALL issue `DeleteObjects` for each returned page
- **AND** after the promise resolves, no key under `pending/evt_big/` SHALL remain

#### Scenario: removePrefix is idempotent

- **GIVEN** no key exists under prefix `pending/evt_nonexistent/`
- **WHEN** `removePrefix("pending/evt_nonexistent/")` is called
- **THEN** the call SHALL resolve without error

#### Scenario: removePrefix logs but does not reject on partial S3 delete failure

- **GIVEN** an S3 backend where `DeleteObjects` returns a per-key error for some keys in a batch
- **WHEN** `removePrefix` processes that batch
- **THEN** the backend SHALL log the failed keys via the injected logger
- **AND** SHALL NOT reject the returned promise
- **AND** SHALL continue to subsequent pages

### Requirement: Filesystem backend

The system SHALL provide a filesystem-backed `StorageBackend` implementation created via a factory function that accepts a root directory path.

- `init` SHALL create the root directory recursively if it does not exist
- `write` SHALL use a write-then-rename pattern (write to `<path>.tmp`, then rename to `<path>`) for atomicity and SHALL encode the string as UTF-8
- `writeBytes` SHALL use the same write-then-rename pattern as `write` and SHALL persist the `Uint8Array` without any encoding transformation
- `read` SHALL read UTF-8 file content
- `readBytes` SHALL read the file as raw bytes and return a `Uint8Array` over its contents
- `list` SHALL yield paths recursively relative to the root directory using `readdir({ recursive: true })`
- `remove` SHALL delete the file using `fs.unlink`
- `move` SHALL use `fs.rename`

#### Scenario: Atomic write survives crash

- **GIVEN** a filesystem backend
- **WHEN** the process crashes during `write("pending/evt_a/000001.json", data)`
- **THEN** either the complete file exists or only a `.tmp` file remains
- **AND** no partial JSON is written to the target path

#### Scenario: Init creates directories

- **GIVEN** a filesystem backend with root `/data/storage`
- **WHEN** `init()` is called
- **THEN** the directory `/data/storage` SHALL exist

#### Scenario: Recursive listing

- **GIVEN** a filesystem backend with files at `pending/evt_a/000000.json` and `pending/evt_a/000001.json`
- **WHEN** `list("pending/")` is iterated
- **THEN** it SHALL yield `"pending/evt_a/000000.json"` and `"pending/evt_a/000001.json"`

### Requirement: S3 backend

The system SHALL provide an S3-compatible `StorageBackend` implementation created via a factory function that accepts bucket name, credentials, and optional endpoint/region.

- `init` SHALL verify bucket access via `HeadBucket`
- `write` SHALL use `PutObject` (natively atomic) with `ContentType: application/json`; the UTF-8 encoding is performed by the S3 client
- `writeBytes` SHALL use `PutObject` with the raw `Uint8Array` as the body and `ContentType: application/octet-stream`
- `read` SHALL use `GetObject` and return the body as a UTF-8 string
- `readBytes` SHALL use `GetObject` and return the body as a `Uint8Array` (via `transformToByteArray`)
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

### Requirement: Storage layout

The storage backend root SHALL house three top-level prefixes:

- `pending/{id}/{seq}.json` — per-invocation pending event files (written live, during an invocation; see `persistence/spec.md`).
- `archive/{id}.json` — per-invocation terminal archive files, each a JSON array of every event for `{id}` in seq order (written once on terminal; see `persistence/spec.md`).
- `workflows/{tenant}.tar.gz` — tenant workflow bundles (see `workflow-registry/spec.md`).

These three prefixes partition the root; no other top-level prefix is reserved by this spec.

#### Scenario: Pending event is written under `pending/`

- **WHEN** a non-terminal event for invocation `evt_a` with seq 1 is persisted
- **THEN** it SHALL be written to `pending/evt_a/000001.json`

#### Scenario: Terminal archive is written under `archive/`

- **WHEN** a terminal event seals invocation `evt_a`
- **THEN** the archive file SHALL be written to `archive/evt_a.json`

#### Scenario: Workflow bundle stored under `workflows/`

- **WHEN** the tenant `acme` uploads a workflow bundle
- **THEN** the bundle SHALL be stored at `workflows/acme.tar.gz`
