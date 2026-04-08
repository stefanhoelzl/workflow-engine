## 1. EventFactory

- [x] 1.1 Create `event-factory.ts` with `createEventFactory(schemas)` returning `{ create, derive, fork }`
- [x] 1.2 Implement `create(type, payload, correlationId)` with payload validation
- [x] 1.3 Implement `derive(parent, type, payload)` with payload validation, correlationId/parentEventId propagation
- [x] 1.4 Implement `fork(parent, { targetAction })` without validation, copying type/payload/correlationId, setting parentEventId
- [x] 1.5 Add unit tests for all three methods including validation errors and metadata propagation

## 2. Action Interface

- [x] 2.1 Update `Action` interface in `actions/index.ts`: remove `match`, add `on: string`
- [x] 2.2 Update `main.ts` `loadWorkflow` to set `on` field from `action.on.name` instead of building a `match` function

## 3. Scheduler Fan-out

- [x] 3.1 Add `EventFactory` parameter to `createScheduler`
- [x] 3.2 Implement fan-out: when `targetAction` is undefined, find actions by `action.on === event.type`, fork and emit copies, transition original to done/skipped
- [x] 3.3 Implement directed routing: find action by `action.name === event.targetAction && action.on === event.type`
- [x] 3.4 Remove ambiguous match handling (multi-match is now fan-out, not an error)
- [x] 3.5 Add fan-out logging (`event.fanout`, `event.fanout.skipped`)
- [x] 3.6 Update scheduler tests for fan-out scenarios and directed routing

## 4. ContextFactory

- [x] 4.1 Update `ContextFactory` constructor to accept `EventFactory` instead of schemas map
- [x] 4.2 Replace `#createAndEmit` with calls to `eventFactory.create()` (httpTrigger) and `eventFactory.derive()` (action) + `bus.emit()`
- [x] 4.3 Remove `#validate` method (moved to EventFactory)
- [x] 4.4 Update context tests

## 5. Cleanup

- [x] 5.1 Delete `actions/dispatch.ts` and `actions/dispatch.test.ts`
- [x] 5.2 Remove `createDispatchAction` import and usage from `main.ts`
- [x] 5.3 Wire `EventFactory` into `main.ts` initialization (create factory, pass to ContextFactory and scheduler)
- [x] 5.4 Update integration tests

## 6. Verify

- [x] 6.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` — all pass
