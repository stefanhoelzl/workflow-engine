## Why

The current persistence write path accumulates multiple state files per event in `pending/`, requiring complex dedup logic in recovery (grouping by eventId, latest-per-event selection, cross-directory merging) and a `latest` flag on the bootstrap interface to distinguish active events from historical ones. Eagerly archiving older files on every write keeps `pending/` clean (at most 1 file per event in normal operation), simplifying both the write model and recovery.

## What Changes

- Modify `handle()` to eagerly archive older files for the same event on every non-initial state transition, and write terminal states (done/failed/skipped) directly to `archive/`
- Simplify `recover()` to handle the crash edge case (at most 2 files per event in `pending/`), then yield pending events followed by archive events
- **BREAKING**: Replace `latest` flag on bootstrap options with `pending` flag — `pending: true` means active work from `pending/` directory, `pending: false` means historical events from `archive/`
- Simplify WorkQueue bootstrap — skip `pending: false` batches, buffer directly from `pending: true` (no dedup needed since `pending/` has at most 1 file per event)
- Update EventStore bootstrap — insert all events regardless of `pending` flag (unchanged behavior, just different flag name)
- Update `main.ts` recovery loop for new `recover()` shape

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `persistence`: Write path eagerly archives older files; terminal states write to archive/; recovery simplified with at-most-2-files crash handling
- `event-bus`: Bootstrap options change from `latest?: boolean` to `pending?: boolean`
- `work-queue`: Bootstrap uses `pending` flag instead of `latest`
- `event-store`: Bootstrap uses `pending` flag instead of `latest`

## Impact

- **event-bus/index.ts**: BusConsumer/EventBus bootstrap options type changes (`latest` → `pending`)
- **event-bus/persistence.ts**: `handle()` write path changes, `recover()` simplified, `RecoveryBatch` uses `pending` instead of `latest`
- **event-bus/work-queue.ts**: Bootstrap checks `pending` instead of `latest`
- **event-bus/event-store.ts**: Bootstrap parameter name change only
- **main.ts**: Recovery loop updated for new batch shape
- **All test files** for affected modules
