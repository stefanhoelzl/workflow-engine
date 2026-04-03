## 1. Event Interface

- [x] 1.1 Add `correlationId` (string, optional) and `parentEventId` (string, optional) to the `Event` interface in `event-queue/index.ts`

## 2. Context and ContextFactory

- [x] 2.1 Create `Context` interface with `emit(type: string, payload: unknown): Promise<void>` in a new `context/index.ts` module
- [x] 2.2 Implement `HttpTriggerContext` with `request`, `definition`, and `emit()` that creates root events (new `corr_` correlationId, no parentEventId)
- [x] 2.3 Implement `ActionContext` with `event` property and `emit()` that creates child events (inherits correlationId, sets parentEventId)
- [x] 2.4 Implement `ContextFactory` class with arrow properties `httpTrigger` and `action`, and shared `#createAndEnqueue()` internal method
- [x] 2.5 Add unit tests for ContextFactory: root event creation, child event creation, correlationId inheritance, parentEventId linkage, arrow property binding

## 3. Action Interface

- [x] 3.1 Update `Action` interface handler signature from `(event: Event) => void` to `(ctx: ActionContext) => Promise<void>`

## 4. Dispatch Refactor

- [x] 4.1 Refactor `createDispatchAction` to accept only the actions list (no queue), and use `ctx.emit()` for fan-out instead of direct `queue.enqueue()`
- [x] 4.2 Update dispatch tests for new ActionContext-based handler signature

## 5. Scheduler Update

- [x] 5.1 Add context factory function parameter to `Scheduler` constructor: `(event: Event) => ActionContext`
- [x] 5.2 Update scheduler loop to construct `ActionContext` via the factory and `await` the async handler
- [x] 5.3 Update scheduler tests for async handlers and context factory injection

## 6. Trigger Middleware Update

- [x] 6.1 Update `httpTriggerMiddleware` to accept a context factory function `(body, definition) => HttpTriggerContext` instead of a raw callback
- [x] 6.2 Middleware calls `ctx.emit(definition.event, body)` to create and enqueue events
- [x] 6.3 Update trigger middleware tests for new context factory signature

## 7. Wiring and Integration

- [x] 7.1 Update `main.ts`: create `ContextFactory`, pass `factory.httpTrigger` to middleware, pass `factory.action` to scheduler, remove direct queue.enqueue from trigger callback
- [x] 7.2 Update `main.ts` demo actions to use new handler signature with chaining: validateOrder emits `order.validated`, two subscribers consume it
- [x] 7.3 Update integration test: trigger → validateOrder → emit → fan-out to 2 subscribers, verify correlationId propagation
