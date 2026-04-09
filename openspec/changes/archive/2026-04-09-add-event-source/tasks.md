## 1. SDK — Thread trigger name

- [x] 1.1 Add `name` field to `TriggerInput` and `HttpTriggerInput` types in `packages/sdk/src/index.ts`
- [x] 1.2 Store trigger name in `WorkflowBuilder.trigger()` (fix `_name` discard) and include `name` in the pushed config object
- [x] 1.3 Update SDK tests in `packages/sdk/src/define-workflow.test.ts` to assert trigger name is preserved in `WorkflowConfig`

## 2. Runtime — Trigger name plumbing

- [x] 2.1 Add `name` field to `HttpTriggerDefinition` and `HttpTriggerResolved` in `packages/runtime/src/triggers/http.ts`; store it in `HttpTriggerRegistry.register()`
- [x] 2.2 Update trigger tests in `packages/runtime/src/triggers/http.test.ts`

## 3. RuntimeEvent schema

- [x] 3.1 Add `sourceType: z.enum(["trigger", "action"])` and `sourceName: z.string()` to `baseFields` in `packages/runtime/src/event-bus/index.ts`
- [x] 3.2 Update `packages/runtime/src/event-bus/index.test.ts` — add `sourceType`/`sourceName` to `makeEvent()` helper

## 4. EventFactory — Source parameter

- [x] 4.1 Add `source` parameter to `create()` method signature and set `sourceType: "trigger"`, `sourceName: source` on returned event
- [x] 4.2 Add `source` parameter to `derive()` method signature and set `sourceType: "action"`, `sourceName: source` on returned event
- [x] 4.3 Copy `sourceType`/`sourceName` from parent in `fork()` method
- [x] 4.4 Update `EventFactory` interface type to reflect new signatures
- [x] 4.5 Update `packages/runtime/src/event-factory.test.ts` — add `sourceType`/`sourceName` to `makeParent()` and assert source fields on all factory outputs

## 5. ContextFactory — Pass source to factory

- [x] 5.1 Update `ContextFactory.httpTrigger()` to pass `definition.name` as `source` to `eventFactory.create()`
- [x] 5.2 Update `ContextFactory.action()` to accept and pass action name as `source` to `eventFactory.derive()`
- [x] 5.3 Update `packages/runtime/src/context/context.test.ts` — add `sourceType`/`sourceName` to `makeEvent()` helper and assert source fields on emitted events

## 6. Scheduler — Thread action name

- [x] 6.1 Update `createScheduler` to pass action name through `createContext` (update `ActionContextFactory` type and `ContextFactory.action` call site)
- [x] 6.2 Update `packages/runtime/src/services/scheduler.test.ts` — add `sourceType`/`sourceName` to `makeEvent()` helper and update `stubContextFactory`

## 7. EventStore — New columns

- [x] 7.1 Add `sourceType TEXT NOT NULL` and `sourceName TEXT NOT NULL` columns to DDL in `packages/runtime/src/event-bus/event-store.ts`
- [x] 7.2 Add `sourceType`/`sourceName` to `EventsTable` interface and `toRow()` mapping
- [x] 7.3 Update `packages/runtime/src/event-bus/event-store.test.ts` — add `sourceType`/`sourceName` to `makeEvent()` helper

## 8. Remaining test fixtures

- [x] 8.1 Update `makeEvent()` in `packages/runtime/src/event-bus/work-queue.test.ts`
- [x] 8.2 Update `makeEvent()` / `makeStoredEvent()` in `packages/runtime/src/event-bus/persistence.test.ts`
- [x] 8.3 Update `makeStoredEvent()` in `packages/runtime/src/event-bus/recovery.test.ts`
- [x] 8.4 Update `packages/runtime/src/integration.test.ts` event fixtures and assertions

## 9. Wiring — main.ts

- [x] 9.1 Update `registerWorkflows` in `packages/runtime/src/main.ts` to pass trigger `name` through to `HttpTriggerRegistry.register()`
- [x] 9.2 Update `ContextFactory.action` usage in scheduler creation to thread action name

## 10. Verification

- [x] 10.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` — all must pass
