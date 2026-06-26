## 1. Interface + error type

- [x] 1.1 In `packages/runtime/src/storage/index.ts`, narrow `StorageBackend` to `write`/`read`/`list` (remove `init`).
- [x] 1.2 Define and export `NotFoundError` (a named `Error` subclass) from the storage module; document that `read` throws it on miss.

## 2. Filesystem backend

- [x] 2.1 In `packages/runtime/src/storage/fs.ts`, make `createFsStorage` `async` and return an already-initialized backend (do the `mkdir -p` of the root during construction; delete the `init` method).
- [x] 2.2 Map `ENOENT` from `read` to `throw new NotFoundError(path)`.
- [x] 2.3 Filter `*.tmp` write-staging artifacts out of `list` output.

## 3. Config

- [x] 3.1 Add `STORAGE_BACKEND` to the Zod schema in `packages/runtime/src/config.ts` (default `"fs"`), exposed as `storageBackend`; carry unknown values through unmodified (factory rejects them).
- [x] 3.2 Update `packages/runtime/src/config.test.ts`: default-to-`fs` and explicit-`fs` cases.

## 4. Backend factory + wiring

- [x] 4.1 Add an async `createStorage(config)` factory (in `storage/index.ts` or `storage/factory.ts`) that dispatches on `config.storageBackend`: `"fs"` → `await createFsStorage(config.persistencePath)`; any other value → throw a descriptive error.
- [x] 4.2 Rewire `packages/runtime/src/main.ts` to `const storageBackend = await createStorage(config)` and remove the separate `storageBackend.init()` call.

## 5. Registry recovery tolerance

- [x] 5.1 In `packages/runtime/src/workflow-registry.ts`, make `recover()` catch `NotFoundError` from `read` per key — log and skip that key, continue recovering the rest.

## 6. Conformance suite

- [x] 6.1 Add `packages/runtime/src/storage/conformance.test.ts`: a backend-agnostic suite (parameterized over a backend factory) asserting the contract — byte roundtrip, recursive `list` over a prefix, exclusion of non-matching keys, `NotFoundError` on missing read, atomic replacement on overwrite.
- [x] 6.2 Crash-recovery case: pre-seed a leftover `*.tmp` artifact in the fs root and assert `list` never yields it (simulates a write that crashed before rename).
- [x] 6.3 Run the suite against `createFsStorage`.

## 7. Existing tests

- [x] 7.1 Update any storage/registry tests that constructed the backend synchronously or called `init()` to use the async factory.

## 8. Definition of Done

- [x] 8.1 `pnpm validate` passes (lint, check, test).
- [x] 8.2 Dev verification against `pnpm dev --random-port --kill`: after the `[READY]` marker, confirm a bundle still uploads and loads — the dashboard drill-down for `demo-repo`/`another-repo` renders, and `.persistence/workflows/local-user/demo-repo.tar.gz` exists on disk.
- [x] 8.3 Dev verification: boot with `STORAGE_BACKEND=s3` and confirm the runtime fails fast (never reaches `[READY]`) with an unrecognised-backend error; boot with it unset and confirm normal startup.
