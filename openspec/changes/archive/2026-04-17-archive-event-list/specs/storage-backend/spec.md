## ADDED Requirements

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
