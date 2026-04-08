## Why

The persistence layer is hardcoded to the local filesystem via `node:fs/promises`. To support deployments where local disk isn't durable (e.g. containers, VPS with S3 backup), we need a storage abstraction that lets the persistence layer run against different backends — starting with S3-compatible object storage.

## What Changes

- Introduce a `StorageBackend` interface abstracting low-level file I/O (write, read, list, remove, move)
- Implement a filesystem backend wrapping the current `node:fs/promises` calls
- Implement an S3 backend using `@aws-sdk/client-s3`
- Refactor `persistence.ts` to use `StorageBackend` instead of direct filesystem calls
- Add S3 configuration env vars (`PERSISTENCE_S3_BUCKET`, `PERSISTENCE_S3_ACCESS_KEY_ID`, etc.)
- Add `@aws-sdk/client-s3` as a required dependency
- Add `s3rver` as a dev dependency for in-process S3 testing

## Capabilities

### New Capabilities

- `storage-backend`: The `StorageBackend` interface and its FS/S3 implementations

### Modified Capabilities

- `persistence`: Refactored to accept a `StorageBackend` instead of using `node:fs/promises` directly
- `runtime-config`: New `PERSISTENCE_S3_*` env vars for S3 backend selection and auth

## Impact

- `packages/runtime/src/event-bus/persistence.ts` — refactored to use `StorageBackend`
- `packages/runtime/src/config.ts` — new S3 config fields
- `packages/runtime/src/main.ts` — backend selection logic (PERSISTENCE_PATH → FS, PERSISTENCE_S3_BUCKET → S3)
- `packages/runtime/package.json` — new dependencies (`@aws-sdk/client-s3`, `s3rver`)
- New files: `packages/runtime/src/storage/{index,fs,s3}.ts`
