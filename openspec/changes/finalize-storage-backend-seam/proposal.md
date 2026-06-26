## Why

`StorageBackend` is the seam through which workflow bundles are persisted, but it is only half-abstract: the lone `createFsStorage` implementation is hardcoded in `main.ts`, `init()` is a forgettable separate lifecycle call, a missing key surfaces as a raw fs `ENOENT`, and there is no config-level way to select a backend. To make a future S3 or Bunny backend a drop-in addition (the painful events-on-object-storage path stays excluded — bundles only), the seam needs hardening and a written contract a future backend author can implement against.

## What Changes

- **Fold `init()` into an async factory.** `createFsStorage` becomes async and returns an already-initialized backend (does its own `mkdir`/connectivity setup). `init()` is removed from the `StorageBackend` interface, which shrinks to `write`/`read`/`list`.
- **Add a config-driven backend factory.** A new `createStorage(config)` async factory dispatches on a new `STORAGE_BACKEND` env var (default `"fs"`); an unknown value fails fast at boot. Only `fs` is registered. `main.ts` constructs the backend via this factory instead of calling `createFsStorage` directly.
- **Define a typed `NotFoundError`.** `read()` of a missing key throws a sentinel `NotFoundError`; the fs backend maps `ENOENT` to it. `WorkflowRegistry.recover()` tolerates it (benign list→read race: log + skip).
- **Re-scope the `storage-backend` capability** to the `workflows/` keyspace it actually governs, and add a **future-backend contract** section (atomic-replace on `write`, `NotFoundError` on read miss, opaque forward-slash keys, unspecified list order) that any S3/Bunny implementation must satisfy.
- **Add a backend conformance test suite** run against `fs` — the executable spec a future remote backend runs against (byte roundtrip, recursive `list`, `NotFoundError` on miss, atomic replace, `.tmp` artifacts never surface in `list`).
- `fs.list` filters `*.tmp` so a crashed write cannot surface an uncommitted key.
- **No remote implementation ships.** No S3/Bunny code, no new dependencies. EventStore/QueueStore (libSQL) are untouched.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `storage-backend`: interface drops `init()` in favor of an async factory and narrows to `write`/`read`/`list`; adds a typed `NotFoundError` read-miss contract, a `createStorage(config)`/`STORAGE_BACKEND` selection requirement, and a normative future-backend contract; the filesystem backend gains `.tmp` exclusion from `list`. **Note:** this evolves the "StorageBackend factory" requirement's recent "SHALL NOT be a multi-backend selector — local disk is the only backend" assertion into the `STORAGE_BACKEND` selector (still fs-only today). This is the bundle-blob layer only and is independent of the libSQL `DATABASE_URL` remote seam (the SQL store).
- `runtime-config`: adds the `STORAGE_BACKEND` environment variable (default `"fs"`, unknown values rejected).

## Impact

- **Code**: `packages/runtime/src/storage/index.ts` (interface change, `NotFoundError`, `createStorage` factory), `packages/runtime/src/storage/fs.ts` (async factory, `ENOENT`→`NotFoundError`, `.tmp` filtering), `packages/runtime/src/main.ts` (construct via `createStorage`, drop the separate `init()` call), `packages/runtime/src/config.ts` (`STORAGE_BACKEND` field), `packages/runtime/src/workflow-registry.ts` (`recover()` tolerates `NotFoundError`).
- **Tests**: new `packages/runtime/src/storage/conformance.test.ts` (backend-agnostic, run against `fs`); update any existing storage/registry/config tests for the async factory + new env.
- **Dependencies**: none added.
- **Not affected**: EventStore/QueueStore (libSQL), the sandbox boundary, the EventBus consumer pipeline, the manifest format, the SDK surface and `demo.ts` (storage is server-internal, not author-facing), infrastructure.
- **Operator**: backward compatible — `STORAGE_BACKEND` defaults to `fs`; `PERSISTENCE_PATH` semantics unchanged.
