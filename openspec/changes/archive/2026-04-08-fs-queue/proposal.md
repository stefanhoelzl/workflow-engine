## Why

The runtime currently uses only an in-memory queue, so all pending events are lost on process restart. We need filesystem-backed persistence for crash recovery (pending events survive restarts) and an audit trail (completed events retained for inspection and future replay).

## What Changes

- **`InMemoryEventQueue` constructor accepts optional `Event[]`** to seed initial pending entries. This enables subclasses and tests to prepopulate the queue.
- **New `FileSystemEventQueue`** extends `InMemoryEventQueue`, adding filesystem persistence:
  - Writes immutable JSON files on `enqueue()` and `ack()`/`fail()`
  - Uses `pending/` directory for active events, `archive/` for completed events
  - Recovers pending events from disk on startup via async factory method
- **Shared contract test suite** that runs behavioral tests against both queue implementations.
- **BREAKING**: The existing event-queue spec described a 4-directory filesystem design (`pending/`, `processing/`, `done/`, `failed/`) that was never implemented. This change replaces that design with a 2-directory model (`pending/`, `archive/`) where state lives in file content, not directory structure.

## Capabilities

### New Capabilities

- `fs-queue`: Filesystem-backed EventQueue implementation with crash recovery, immutable append-only event files, and archival of completed events.

### Modified Capabilities

- `event-queue`: InMemoryEventQueue constructor changes to accept optional initial events. Existing filesystem-related requirements (lines 105-153) are superseded by the new `fs-queue` capability. Shared contract test suite added.

## Impact

- `packages/runtime/src/event-queue/in-memory.ts` — constructor signature change (backward compatible, parameter is optional)
- `packages/runtime/src/event-queue/` — new `fs-queue.ts` file
- `packages/runtime/src/event-queue/in-memory.test.ts` — refactored into shared contract tests
- `packages/runtime/src/main.ts` — select queue backend via `EVENT_QUEUE_PATH` env var: if set, use `FileSystemEventQueue`; if not, use `InMemoryEventQueue`
- No changes to the `EventQueue` interface itself
- New dev dependency: none expected (uses `node:fs/promises` only)
