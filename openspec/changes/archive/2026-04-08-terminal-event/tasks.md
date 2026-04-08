## 1. RuntimeEvent schema

- [x] 1.1 Rewrite `RuntimeEventSchema` in `event-bus/index.ts` as a `z.union()` of four object variants (ActiveEvent, SucceededEvent, SkippedEvent, FailedEvent) with shared base fields
- [x] 1.2 Update `RuntimeEvent` type export and verify TypeScript narrowing works (state → result → error)

## 2. Event emit sites

- [x] 2.1 Update scheduler `processEvent` / `fanOut` / `executeAction` in `services/scheduler.ts` to emit `{ state: "done", result }` instead of `{ state: "done" | "failed" | "skipped" }`
- [x] 2.2 Update any emit sites in `context/index.ts` or trigger code if they construct terminal events

## 3. Persistence

- [x] 3.1 Simplify `isTerminal` check in `persistence.ts` `handle()` to `event.state === "done"`
- [x] 3.2 Update persistence tests to use new event shape (state/result split) and verify terminal routing for all three result values

## 4. EventStore

- [x] 4.1 Add `result TEXT` column to DuckDB DDL in `event-store.ts` and update `toRow()` mapping
- [x] 4.2 Update EventStore tests for new event shape

## 5. EventFactory and WorkQueue

- [x] 5.1 Update `event-factory.ts` if it constructs events with terminal states
- [x] 5.2 Verify work-queue logic still works unchanged (`state !== "pending"` / `state === "pending" || state === "processing"`)

## 6. Validation

- [x] 6.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` — fix any remaining type errors or test failures
