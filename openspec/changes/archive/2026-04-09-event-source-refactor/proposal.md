## Why

EventFactory and EventBus are always passed together as dependencies (to ContextFactory and Scheduler), and the usage pattern is always "factory creates event → bus emits it." This coupling is implicit and scattered, leading to duplicated wiring and redundant logging. Merging them into a unified EventSource that auto-emits on creation simplifies dependency injection, centralizes event lifecycle management, and removes several intermediate abstractions that exist only to bridge the two.

## What Changes

- **BREAKING**: Rename `EventFactory` to `EventSource`; rename `event-factory.ts` to `event-source.ts`
- **BREAKING**: `createEventSource(schemas, bus)` replaces `createEventFactory(schemas)` — bus is now a dependency
- `create()`, `derive()`, `fork()` auto-emit to the bus and return the event
- New `transition(event, opts)` method on EventSource for state changes (processing, done/succeeded, done/skipped, done/failed) with discriminated union types
- **BREAKING**: Add lifecycle timestamps to RuntimeEvent: `emittedAt` (per-emit), rename `createdAt` semantics (event birth), add `startedAt`, `doneAt`
- **BREAKING**: Remove `HttpTriggerContext` class — `httpTriggerMiddleware` calls `source.create()` directly
- **BREAKING**: Remove `ContextFactory` class — inline as `createActionContext()` function
- Remove `Context` interface and `EmitOptions` interface (including `targetAction` option from `ctx.emit()`)
- Remove `TriggerContextFactory` type
- New logging bus consumer replaces scattered logging across ContextFactory and Scheduler
- Scheduler drops its logger dependency — all event lifecycle logging flows through the bus consumer

## Capabilities

### New Capabilities
- `event-source`: Unified EventSource interface that creates events and auto-emits them to the bus, including state transitions and lifecycle timestamps
- `logging-consumer`: Bus consumer that provides centralized event lifecycle logging, replacing scattered logging in ContextFactory and Scheduler

### Modified Capabilities
- `event-factory`: **REMOVED** — fully replaced by the new `event-source` capability
- `event-bus`: RuntimeEvent gains new timestamp fields (`emittedAt`, `startedAt`, `doneAt`); `createdAt` becomes immutable event birth time
- `context`: Remove HttpTriggerContext, Context interface, EmitOptions; inline ContextFactory as createActionContext()
- `scheduler`: Replace dual (bus, factory) dependency with single EventSource; remove direct logger calls
- `event-store`: Schema gains `emittedAt`, `startedAt`, `doneAt` columns; `createdAt` semantics change
- `logging`: Structured logging moves from ContextFactory/#logEmit and Scheduler to a dedicated bus consumer
- `triggers`: httpTriggerMiddleware takes EventSource directly instead of TriggerContextFactory

## Impact

- **Runtime package**: Core refactor across event-factory, event-bus, context, scheduler, triggers, main.ts
- **Event store schema**: New columns require migration (DuckDB in-memory, so schema change on restart)
- **Dashboard queries**: `createdAt` references become `emittedAt` for row-level ordering
- **Tests**: All tests touching EventFactory, ContextFactory, Scheduler, httpTriggerMiddleware need updates
- **No SDK impact**: SDK does not expose EventFactory, EventBus, or EmitOptions
- **No sandbox impact**: Change is runtime-internal, does not affect the isolate boundary
