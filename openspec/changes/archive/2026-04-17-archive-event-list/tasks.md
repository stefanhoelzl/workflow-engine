## 1. StorageBackend — `removePrefix` primitive

- [x] 1.1 Add `removePrefix(prefix: string): Promise<void>` to the `StorageBackend` interface in `packages/runtime/src/storage/index.ts`.
- [x] 1.2 Implement `removePrefix` in `packages/runtime/src/storage/fs.ts` using `fs.rm(path, { recursive: true, force: true })`; treat ENOENT as success.
- [x] 1.3 Implement `removePrefix` in `packages/runtime/src/storage/s3.ts` as a paginated `ListObjectsV2 → DeleteObjects` loop; accept an injected logger; log per-key failures; never reject on partial failure.
- [x] 1.4 Extend `packages/runtime/src/storage/storage-backend.test.ts` (shared FS + S3 suite) with: removes all nested files, is idempotent on empty prefix, does not affect keys outside the prefix. Pagination and partial-delete-failure logging follow the same code paths as existing `list` pagination and are covered structurally; explicit integration tests for those would require >1000-key fixtures or S3Client mocking and were deferred.

## 2. Persistence — nested pending + batch archive

- [x] 2.1 Change `pendingPath` in `packages/runtime/src/event-bus/persistence.ts` to `pending/{id}/{seq-padded-6}.json`.
- [x] 2.2 Change `archivePath` to `archive/{id}.json`; delete the per-seq `archive/{id}/{seq}.json` helper.
- [x] 2.3 Update `parsePendingPath` regex to match the nested layout; `parseArchivePath` now matches `archive/{id}.json` and returns `{ id }` only.
- [x] 2.4 Replace `pendingSeqs: Map<string, number[]>` with `pendingEvents: Map<string, InvocationEvent[]>`.
- [x] 2.5 In `writePending`, append the event to `pendingEvents[id]` only after the pending write resolves.
- [x] 2.6 In `archiveInvocation`, write a single `archive/{id}.json` containing `JSON.stringify(pendingEvents.get(id))`; on success, `pendingEvents.delete(id)`; then call `backend.removePrefix(pendingPrefix(id))` (best-effort).
- [x] 2.7 On archive write failure, log `persistence.archive-failed` and leave accumulator + pending files intact (no cleanup, no accumulator clear).
- [x] 2.8 Delete `discoverPendingSeqs` (dead code under in-memory accumulation).
- [x] 2.9 Update `scanArchive` to read each `archive/{id}.json` and yield each element of the parsed JSON array; preserve the `InvocationEvent` yield contract; skip malformed files.
- [x] 2.10 Update `scanPending` to parse the nested path layout; preserve the `InvocationEvent` yield contract.

## 3. Persistence tests

- [x] 3.1 Update existing tests in `packages/runtime/src/event-bus/persistence.test.ts` for the new pending and archive layouts.
- [x] 3.2 Add a test: terminal event writes a single `archive/{id}.json` containing the full event array in seq order.
- [x] 3.3 Add a test: after terminal, `pending/{id}/` is empty and the accumulator entry is cleared (covered alongside 3.2).
- [x] 3.4 Add a test: archive write failure leaves accumulator + pending files intact (no cleanup).
- [x] 3.5 Add a test: `scanArchive` yields every event from an archive file containing a JSON array of multiple events.
- [x] 3.6 Add a test: `scanPending` yields one event per nested pending file, parses seq and id correctly from the padded path.

## 4. Recovery — archive-authoritative rule

- [x] 4.1 Change `recover` signature in `packages/runtime/src/recovery.ts` to `recover({ backend, eventStore }, bus)`.
- [x] 4.2 For each pending id found via `scanPending`, query the event store (`eventStore.query.where("id","=",id).select("id").limit(1).execute()`) to determine archive authority.
- [x] 4.3 If the event store has any event for that id: call `backend.removePrefix(pendingPrefix(id))`, log `runtime.recovery.archive-cleanup` at info level with `{ id, count }`, and skip replay.
- [x] 4.4 Otherwise: keep current replay-through-bus behavior + synthetic `trigger.error` (seq = max + 1) so persistence archives normally.
- [x] 4.5 Thread `eventStore` through `packages/runtime/src/main.ts` into `recover(...)`.

## 5. Recovery tests

- [x] 5.1 Unit test in `packages/runtime/src/recovery.test.ts`: when `eventStore` reports id `X` is archived, recovery calls `removePrefix("pending/X/")` and emits nothing to the bus for `X`.
- [x] 5.2 Unit test: when `eventStore` has no events for id `X`, recovery replays each pending event to the bus in seq order and emits a synthetic `trigger.error` with the next seq.
- [x] 5.3 Unit test: empty `pending/` is a no-op (no emits, no removePrefix).

## 6. Integration test — crash during cleanup

- [x] 6.1 Add a test in `packages/runtime/src/integration.test.ts` that seeds `archive/evt_a.json` with a complete event array plus partial pending leftovers at `pending/evt_a/000001.json` and `pending/evt_a/000003.json`.
- [x] 6.2 Boot the real wiring: `backend.init()` → `createEventStore({ persistence: { backend } })` → `await eventStore.initialized` → `createPersistence(backend)` → `recover({ backend, eventStore }, bus)`.
- [x] 6.3 Assert: after recovery, `pending/evt_a/` is empty; `archive/evt_a.json` is byte-identical; event store has the original rows (no duplicates, no synthetic `trigger.error` row).

## 7. Event store bootstrap test fixture

- [x] 7.1 Update `packages/runtime/src/event-bus/event-store.test.ts` bootstrap test fixture to write `archive/{id}.json` in the new JSON-array format.
- [x] 7.2 Verify the bootstrap test still passes with the new `scanArchive` implementation.

## 8. Validation

- [x] 8.1 Run `pnpm validate` (lint, format check, typecheck, tests) — must pass clean.
- [x] 8.2 Run `pnpm exec openspec validate archive-event-list --strict` — must report valid.
