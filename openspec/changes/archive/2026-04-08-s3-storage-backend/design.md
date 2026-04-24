## Context

The persistence layer (`persistence.ts`) currently imports `node:fs/promises` directly for all I/O. This couples persistence to the local filesystem. We want to support S3-compatible object storage as an alternative backend without changing persistence logic.

Current persistence I/O operations: `writeFile` (via atomic tmp+rename), `readFile`, `readdir`, `rename` (for archival), `mkdir`.

## Goals / Non-Goals

**Goals:**
- Introduce a `StorageBackend` interface at the file I/O level
- Implement FS and S3 backends behind this interface
- Refactor persistence to use `StorageBackend` instead of `node:fs/promises`
- Backend selection via environment variables

**Non-Goals:**
- Dual-write (simultaneous FS + S3)
- Event-level abstraction (the interface operates on paths and strings, not events)
- Streaming reads/writes (events are small JSON files)
- AWS credential chain support (explicit env vars only)

## Decisions

### StorageBackend interface at file I/O level

```typescript
interface StorageBackend {
  init(): Promise<void>
  write(path: string, data: string): Promise<void>
  read(path: string): Promise<string>
  list(prefix: string): AsyncIterable<string>
  remove(path: string): Promise<void>
  move(from: string, to: string): Promise<void>
}
```

> **Note (post-design addendum):** The string `write`/`read` methods use UTF-8 encoding internally. A follow-up change added byte-oriented siblings `writeBytes(path, data: Uint8Array)` and `readBytes(path): Promise<Uint8Array>` for binary payloads (workflow bundle tarballs, action upload blobs) where UTF-8 round-tripping would corrupt data. The byte methods share the same atomicity guarantees as their string counterparts (tmp+rename on FS, `PutObject` on S3). See `openspec/specs/storage-backend/spec.md` for the current authoritative interface.

**Why**: The persistence layer already has well-tested logic for counters, naming, pending/archive semantics, and recovery. Abstracting at the file I/O level lets us keep all of that unchanged. An event-level abstraction would duplicate persistence logic in each backend.

**Alternatives considered**: Event-level `EventStore` interface (save/load/archive/recover) — rejected because it would require each backend to reimplement persistence semantics.

### `write` is assumed atomic, atomicity strategy is internal

FS backend uses tmp+rename internally. S3 uses `PutObject` which is natively atomic. The interface doesn't expose tmp files or rename-for-atomicity.

**Why**: The tmp+rename pattern is an FS-specific concern. S3 doesn't need it. Each backend handles atomicity in the way natural to its storage.

### `move` is copy+delete on S3 (non-atomic)

S3 has no rename operation. `move` is implemented as `CopyObject` + `DeleteObject`.

**Why**: If a crash occurs between copy and delete, the file exists in both source and destination. The persistence recovery logic already handles this — it re-archives stale pending files on startup. The idempotent recovery makes this safe.

### `list` returns `AsyncIterable<string>`

Each iteration yields one path string. FS yields entries from `readdir` one at a time. S3 paginates `ListObjectsV2` internally and yields keys across page boundaries.

**Why**: S3 returns results in pages of 1000. Returning all keys as `Promise<string[]>` requires buffering the entire listing. `AsyncIterable<string>` lets the interface stream without exposing page boundaries. The persistence layer collects into an array when it needs to sort/group — that's the consumer's choice.

### Explicit S3 env vars, no credential chain

| Env Var | Required | Purpose |
|---------|----------|---------|
| `PERSISTENCE_S3_BUCKET` | Yes | Bucket name |
| `PERSISTENCE_S3_ACCESS_KEY_ID` | Yes | Auth |
| `PERSISTENCE_S3_SECRET_ACCESS_KEY` | Yes | Auth |
| `PERSISTENCE_S3_ENDPOINT` | No | Custom endpoint (MinIO, R2) |
| `PERSISTENCE_S3_REGION` | No | AWS region |

**Why**: Explicit env vars keep configuration self-contained and predictable. No implicit file lookups (`~/.aws/credentials`) or metadata service calls (IMDSv2). Backend selection is implicit: `PERSISTENCE_S3_BUCKET` set → S3, `PERSISTENCE_PATH` set → FS.

### `@aws-sdk/client-s3` as required dependency

**Why**: Simpler than optional/peer deps with runtime checks. The package adds ~5MB to node_modules but avoids conditional import complexity.

### File layout: `src/storage/` directory

```
packages/runtime/src/storage/
  index.ts     # StorageBackend interface, createStorageBackend factory
  fs.ts        # FS implementation
  s3.ts        # S3 implementation
```

**Why**: Separates storage concern from event-bus. The interface is generic (not event-specific) and could be reused.

### Testing with s3rver

Shared test suite runs against both backends. `s3rver` provides an in-process S3-compatible server — no Docker required.

**Why**: Lightweight, runs in CI without Docker, exercises real S3 API calls.

## Risks / Trade-offs

**S3 latency vs FS** — S3 writes are ~10-50ms vs <1ms for local FS. Every event state transition incurs this latency. → Acceptable for the use case (VPS with S3 backup). Not intended for latency-sensitive workloads.

**Non-atomic move** — Copy+delete on S3 can leave duplicates on crash. → Recovery handles this idempotently. Documented as a known behavior.

**`list` collection overhead** — Persistence must collect all list results before sorting/grouping. → Pending directory is expected to stay small (active events only). Archive grows unbounded but is only listed during recovery.

**Required S3 dependency** — Adds weight for FS-only users. → Acceptable tradeoff for simpler code.

```
  PERSISTENCE REFACTORING
  ════════════════════════════════════════════════════

  BEFORE                          AFTER
  ──────                          ─────

  persistence.ts                  persistence.ts
  ├── import { mkdir,             ├── accept StorageBackend
  │     readFile, readdir,        │
  │     rename, writeFile }       ├── backend.write(...)
  │     from "node:fs/promises"   ├── backend.read(...)
  │                               ├── backend.list(...)
  ├── atomicWrite(path, data)     ├── backend.move(...)
  ├── listEventFiles(dir)         └── backend.remove(...)
  ├── archiveFiles(from, to)
  └── readFile(path)              Persistence logic unchanged:
                                  counters, naming, pending/archive,
                                  recovery, eager archive
```
