## Why

Invocation finalization currently performs `3 * N` storage operations per invocation — for each of the `N` events, the persistence consumer reads the pending file, writes an archive file, then removes the pending file. On S3 this is `3N` HTTP requests per invocation, linear in event count. This change collapses finalization to a constant `~2` S3 calls regardless of `N` by writing a single archive file containing the full event list and removing pending files via prefix removal.

This change also corrects spec drift in `persistence/spec.md`, which currently describes a `pending/<id>.json` / `archive/<id>.json` layout that the code never fully implemented.

## What Changes

- Consolidate `archive/{id}/{seq}.json` per-event files into a single `archive/{id}.json` file containing a JSON array of `InvocationEvent` (one entry per event, including the terminal event).
- Nest pending files under a per-invocation directory: `pending/{id}/{seq}.json` replaces the flat `pending/{id}_{seq}.json` layout. Seq suffix is zero-padded to 6 digits on write (parsers accept any width).
- Accumulate events in memory during an invocation (`Map<id, InvocationEvent[]>`) so the archive write does not re-read pending files.
- Add `removePrefix(prefix: string): Promise<void>` to the `StorageBackend` interface. Used to clean up `pending/{id}/` after the archive is durable. FS impl uses recursive `rm`; S3 impl uses paginated `ListObjectsV2` + `DeleteObjects`.
- Recovery becomes archive-authoritative: if the event store contains any event for a pending id (populated from the archive bootstrap that precedes recovery), recovery calls `removePrefix` on that pending prefix and skips replay. Only pending ids absent from the event store are replayed with a synthetic `trigger.error`. Recovery now takes `eventStore` as a dep.
- Correct stale `persistence/spec.md` in the same change — the spec's description of a scalar-file pending/archive layout is replaced with the real per-event pending + batch archive invariants.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `persistence`: changes pending layout to `pending/{id}/{seq}.json`, archive layout to a single `archive/{id}.json` containing a JSON array, and introduces the in-memory accumulator + defensive cleanup ordering. Also corrects drift where the current spec describes a layout never implemented.
- `storage-backend`: adds `removePrefix(prefix)` as a best-effort primitive with defined FS and S3 semantics (paginated LIST+DELETE on S3, recursive FS `rm`).
- `recovery`: archive-authoritative rule — recovery queries the event store to decide whether to replay pending files or to clean them up silently. Adds `eventStore` as a dep.

## Impact

- **Affected code**: `packages/runtime/src/event-bus/persistence.ts`, `packages/runtime/src/event-bus/event-store.ts` (bootstrap reads new format), `packages/runtime/src/recovery.ts`, `packages/runtime/src/main.ts` (threads `eventStore` into `recover`), `packages/runtime/src/storage/index.ts` + `fs.ts` + `s3.ts` (new primitive).
- **Affected tests**: `persistence.test.ts`, `event-store.test.ts`, `recovery.test.ts`, `storage-backend.test.ts`, `integration.test.ts`.
- **Affected specs**: `persistence`, `storage-backend`, `recovery`.
- **No migration**: local dev re-inits each restart; prod has no durable invocations in the old format that must be preserved. Old-format files are ignored (not read, not deleted).
- **No dependency changes**.
- **No manifest or sandbox boundary changes**.
