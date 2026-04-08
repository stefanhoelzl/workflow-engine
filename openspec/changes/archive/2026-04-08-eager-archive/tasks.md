## 1. Bootstrap Interface

- [x] 1.1 Replace `latest?: boolean` with `pending?: boolean` on bootstrap options in `event-bus/index.ts`

## 2. Persistence Write Path

- [x] 2.1 Modify `handle()` for non-terminal states: after writing to `pending/`, fire-and-forget archive older files for the same event ID
- [x] 2.2 Modify `handle()` for terminal states: write directly to `archive/` instead of `pending/`, then fire-and-forget archive remaining `pending/` files
- [x] 2.3 Update persistence handle tests for eager archive behavior and terminal-to-archive writes

## 3. Persistence Recovery

- [x] 3.1 Simplify `recover()`: scan `pending/`, group by eventId, take latest (handles crash case of 2 files), move older to archive
- [x] 3.2 Yield pending events with `{ pending: true }`, then archive events with `{ pending: false, finished: true }`
- [x] 3.3 Replace `RecoveryBatch.latest` with `RecoveryBatch.pending`
- [x] 3.4 Update recovery tests for new batch shape and simplified dedup

## 4. WorkQueue

- [x] 4.1 Replace `latest` check with `pending` check in `bootstrap()` — skip when `pending: false`
- [x] 4.2 Update work-queue tests (`latest` → `pending`)

## 5. EventStore

- [x] 5.1 Replace `latest` parameter name with `pending` in `bootstrap()` (behavior unchanged)
- [x] 5.2 Update event-store tests (`latest` → `pending`)

## 6. Wiring

- [x] 6.1 Update `main.ts` recovery loop for new `RecoveryBatch` shape (`pending` instead of `latest`)
- [x] 6.2 Update integration tests
