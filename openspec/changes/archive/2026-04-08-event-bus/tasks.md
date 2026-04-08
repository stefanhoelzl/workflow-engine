## 1. SDK Event Type

- [x] 1.1 Export `Event` type from `@workflow-engine/sdk` (`{ name: string, payload: unknown }`)

## 2. EventBus Core

- [x] 2.1 Create `event-bus/index.ts` with `RuntimeEventSchema`, `RuntimeEvent` type, `BusConsumer` interface, `EventBus` interface, and `createEventBus()` factory
- [x] 2.2 Write tests for `createEventBus`: ordered fan-out on emit, ordered fan-out on bootstrap, consumer error propagation, empty consumer list, finished signal passthrough

## 3. Persistence Consumer

- [x] 3.1 Create `event-bus/persistence.ts` with factory function, `handle()` (atomic write + fire-and-forget archive), empty `bootstrap()`, and `recover()` yielding batches
- [x] 3.2 Write tests for persistence handle: writes append-only files per state, atomic write pattern, counter increments, fire-and-forget archive on terminal states
- [x] 3.3 Write crash recovery tests: recover pending events, recover processing events, complete interrupted archives, counter recovery from existing files, empty directories

## 4. WorkQueue Consumer

- [x] 4.1 Create `event-bus/work-queue.ts` with `createWorkQueue()` factory, `handle()` filtering on pending state, `bootstrap()` buffering pending+processing, and blocking `dequeue()` with AbortSignal
- [x] 4.2 Write tests for WorkQueue: handle buffers pending only, bootstrap buffers pending+processing, dequeue returns buffered events, dequeue blocks when empty, dequeue resolves on handle, FIFO waiter order, AbortSignal cancellation, no enqueue method

## 5. Scheduler Migration

- [x] 5.1 Update `createScheduler()` to accept `WorkQueue` + `EventBus` instead of `EventQueue`. Emit state transitions (processing/done/failed/skipped) via `bus.emit()`. Strip RuntimeEvent to SDK Event before creating ActionContext.
- [x] 5.2 Update scheduler tests: verify bus.emit called with correct states for each scenario (success, failure, no-match/skipped, ambiguous-match), verify actions receive SDK Event not RuntimeEvent

## 6. Context Migration

- [x] 6.1 Update `ContextFactory` to accept `EventBus` instead of `EventQueue`. Change `#createAndEnqueue` to `#createAndEmit`, constructing a `RuntimeEvent` with `state: "pending"` and calling `bus.emit()`.
- [x] 6.2 Update context tests: verify RuntimeEvent shape emitted to bus, verify correlationId/parentEventId propagation, verify payload validation still rejects before bus.emit

## 7. Startup Orchestration

- [x] 7.1 Update `main.ts`: create persistence, workQueue, bus with `[persistence, workQueue]`. Bootstrap via `persistence.recover()` → `bus.bootstrap()` batches. Pass workQueue + bus to scheduler. Pass bus to ContextFactory.
- [x] 7.2 Write integration test for full startup/recovery: persist events to FS, restart, verify bootstrap populates WorkQueue, verify scheduler can dequeue recovered events

## 8. Cleanup

- [x] 8.1 Delete `event-queue/index.ts`, `event-queue/in-memory.ts`, `event-queue/fs-queue.ts` and their test files
- [x] 8.2 Update all imports across the codebase from `event-queue` to `event-bus`
- [x] 8.3 Verify `pnpm lint`, `pnpm check`, and `pnpm test` pass
