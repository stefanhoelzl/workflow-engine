## 1. Event Queue Extensions

- [x] 1.1 Add `targetAction?: string` to the `Event` type in `packages/runtime/src/event-queue/index.ts`
- [x] 1.2 Add promise-based `enqueue`, `dequeue`, `ack`, `fail` methods to the `EventQueue` interface
- [x] 1.3 Implement `InMemoryEventQueue` with state tracking (pending → processing → done/failed) and blocking `dequeue` that resolves when an event becomes available
- [x] 1.4 Add tests for `InMemoryEventQueue` lifecycle (enqueue, dequeue, ack, fail, blocking dequeue resolves on enqueue)

## 2. Action System

- [x] 2.1 Create `Action` type (`name`, `match`, `handler`) in `packages/runtime/src/actions/index.ts`
- [x] 2.2 Create the built-in dispatch action in `packages/runtime/src/actions/dispatch.ts` — matches `targetAction === undefined`, finds subscribers via synthetic event matching, enqueues cloned events
- [x] 2.3 Add tests for dispatch: fan-out to multiple subscribers, zero subscribers, dispatch skips itself

## 3. Scheduler

- [x] 3.1 Implement scheduler await loop in `packages/runtime/src/scheduler/index.ts` — await dequeue, match actions, run handler, ack/fail
- [x] 3.2 Handle match cases: 0 matches (ack), 1 match (run), >1 matches (fail)
- [x] 3.3 Add `start()`/`stop()` methods for the await loop
- [x] 3.4 Add tests for scheduler: successful execution, action throws, no match, ambiguous match, start/stop

## 4. Wire Up Runtime

- [x] 4.1 Update `main.ts` to set `targetAction: undefined` on trigger-created events
- [x] 4.2 Register dispatch action and hardcoded sample actions, create scheduler, and start it in `main.ts`
- [x] 4.3 Add integration test: HTTP request → trigger → dispatch → action execution
