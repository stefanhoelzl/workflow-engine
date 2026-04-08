## 1. Event Factory

- [x] 1.1 Remove `correlationId` parameter from `EventFactory` interface and `create()` implementation in `event-factory.ts`; generate `corr_${crypto.randomUUID()}` inside `create()`
- [x] 1.2 Update `event-factory.test.ts`: remove `correlationId` argument from `create()` calls, assert correlation ID is set on returned events

## 2. Context Factory

- [x] 2.1 Remove correlation ID generation and parameter passing in `ContextFactory.httpTrigger()` in `context/index.ts`
- [x] 2.2 Update `context/context.test.ts`: adjust mock `create()` signature and any assertions involving correlation ID passing

## 3. Verification

- [x] 3.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` — all pass
