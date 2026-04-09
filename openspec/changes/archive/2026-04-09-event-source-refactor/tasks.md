## 1. RuntimeEvent Schema Changes

- [x] 1.1 Add `emittedAt` (Date, coerced), `startedAt` (optional Date, coerced), `doneAt` (optional Date, coerced) fields to RuntimeEventSchema in `event-bus/index.ts`
- [x] 1.2 Rename existing `createdAt` semantics: it remains on the schema but now represents event birth time; add `emittedAt` as the per-emit timestamp
- [x] 1.3 Update RuntimeEventSchema discriminated union to use `state: "done"` with `result: "succeeded" | "skipped" | "failed"` (replacing flat `state: "done" | "failed" | "skipped"`)
- [x] ~~1.4 Handle backwards compatibility~~ — not needed
- [x] 1.5 Update RuntimeEvent schema tests

## 2. EventSource Implementation

- [x] 2.1 Rename `event-factory.ts` to `event-source.ts`; rename `EventFactory` interface to `EventSource`; rename `createEventFactory` to `createEventSource`
- [x] 2.2 Add `bus: EventBus` parameter to `createEventSource(schemas, bus)`
- [x] 2.3 Make `create()`, `derive()`, `fork()` async — add `bus.emit()` call after construction, set `emittedAt` and `createdAt` on each
- [x] 2.4 Implement `transition(event, opts)` method with discriminated union types; set `emittedAt`, `startedAt`, `doneAt` per the spec
- [x] 2.5 Add/update EventSource unit tests (auto-emit verified via collector consumer, transition types, timestamp fields, immutability)

## 3. Context Refactor

- [x] 3.1 Remove `EmitOptions` interface and `targetAction` option from `ctx.emit()` — simplify emit signature to `(type, payload)`
- [x] 3.2 Remove `HttpTriggerContext` class and `Context` interface
- [x] 3.3 Replace `ContextFactory` class with `createActionContext(source, fetch, env, logger)` function returning `(event: RuntimeEvent) => ActionContext`
- [x] 3.4 Update `ActionContext.emit()` to delegate to `source.derive()` instead of manual eventFactory.derive() + bus.emit()
- [x] 3.5 Remove `#logEmit` method — logging is now handled by the bus consumer
- [x] 3.6 Update context unit tests

## 4. Logging Consumer

- [x] 4.1 Create `LoggingConsumer` implementing `BusConsumer` in a new module (e.g. `event-bus/logging-consumer.ts`)
- [x] 4.2 Implement `handle(event)`: log at info for pending, trace for processing/done, error for failed; include correlationId, eventId, type, targetAction, result, error
- [x] 4.3 Implement `bootstrap(events)`: log at info with count
- [x] 4.4 Add LoggingConsumer unit tests

## 5. Scheduler Refactor

- [x] 5.1 Change `createScheduler` signature: replace `(workQueue, bus, actions, eventFactory, createContext, logger)` with `(workQueue, source, actions, createContext)`
- [x] 5.2 Replace all `bus.emit({...event, state})` calls with `source.transition(event, opts)`
- [x] 5.3 Replace `eventFactory.fork()` + `bus.emit()` with `source.fork()`
- [x] 5.4 Remove all direct `logger.*` calls from the scheduler
- [x] 5.5 Update scheduler unit tests

## 6. Triggers Refactor

- [x] 6.1 Change `httpTriggerMiddleware` signature: replace `(registry, createContext: TriggerContextFactory)` with `(registry, source: EventSource)`
- [x] 6.2 Replace `createContext(body, definition)` + `ctx.emit()` with `source.create(definition.event, body)` — keep PayloadValidationError handling
- [x] 6.3 Remove `TriggerContextFactory` type export
- [x] 6.4 Update trigger middleware tests

## 7. Event Store Schema Update

- [x] 7.1 Add `emittedAt`, `startedAt`, `doneAt` nullable TIMESTAMPTZ columns to the DDL in `event-bus/event-store.ts`
- [x] 7.2 Update `toRow()` to map the new timestamp fields
- [x] 7.3 Update dashboard queries: replace `createdAt` with `emittedAt` in `LATEST_STATE_CTE` ordering, timeline ordering, and correlation summary `lastEventAt`
- [x] 7.4 Update event store and dashboard query tests

## 8. Main.ts Wiring

- [x] 8.1 Create LoggingConsumer and add it as last consumer in bus array: `[persistence?, workQueue, eventStore, logging]`
- [x] 8.2 Replace `createEventFactory(allEvents)` with `createEventSource(allEvents, bus)`
- [x] 8.3 Replace `new ContextFactory(...)` with `createActionContext(source, fetch, env, logger)`
- [x] 8.4 Update `httpTriggerMiddleware(registry, contextFactory.httpTrigger)` to `httpTriggerMiddleware(registry, source)`
- [x] 8.5 Update `createScheduler(...)` call to new signature
- [x] 8.6 Remove recovery count log from main.ts (handled by LoggingConsumer.bootstrap)
- [x] 8.7 Update imports: event-source instead of event-factory, remove ContextFactory

## 9. Integration Tests

- [x] 9.1 Update integration tests to use EventSource instead of separate EventFactory + EventBus
- [x] 9.2 Verify full flow: trigger → create → fan-out → action → derive → done, with timestamps and logging consumer
- [x] 9.3 Verify recovery flow: bootstrap with logging consumer logs count
