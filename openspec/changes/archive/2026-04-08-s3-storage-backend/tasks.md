## 1. StorageBackend Interface & FS Implementation

- [x] 1.1 Create `src/storage/index.ts` with `StorageBackend` interface and `createStorageBackend` factory
- [x] 1.2 Create `src/storage/fs.ts` — filesystem backend (atomic write via tmp+rename, list via readdir, move via rename, remove via unlink)
- [x] 1.3 Add shared StorageBackend interface tests that run against FS backend (write/read roundtrip, list filtering, move, remove)

## 2. S3 Implementation

- [x] 2.1 Add `@aws-sdk/client-s3` and `s3rver` dependencies
- [x] 2.2 Create `src/storage/s3.ts` — S3 backend (PutObject, GetObject, ListObjectsV2 with pagination, CopyObject+DeleteObject for move, HeadBucket for init)
- [x] 2.3 Run shared StorageBackend interface tests against S3 backend using s3rver

## 3. Configuration

- [x] 3.1 Add `PERSISTENCE_S3_*` env vars to config schema with mutual exclusion validation against `PERSISTENCE_PATH`
- [x] 3.2 Add config tests for S3 fields and mutual exclusion error

## 4. Persistence Refactoring

- [x] 4.1 Refactor `persistence.ts` to accept a `StorageBackend` instead of importing `node:fs/promises`
- [x] 4.2 Update persistence tests to use FS StorageBackend
- [x] 4.3 Add persistence recovery crash-safety tests with S3 backend (non-atomic move edge case)

## 5. Integration

- [x] 5.1 Update `main.ts` to create StorageBackend from config and pass to persistence factory
- [x] 5.2 Verify `pnpm lint`, `pnpm check`, and `pnpm test` pass
