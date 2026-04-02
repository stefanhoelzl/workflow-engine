## 1. Event type and EventQueue interface

- [x] 1.1 Create `packages/runtime/src/event-queue/index.ts` with `Event` type and `EventQueue` interface (enqueue only)

## 2. In-memory implementation

- [x] 2.1 Create `packages/runtime/src/event-queue/in-memory.ts` with `InMemoryEventQueue` class

## 3. Wire trigger to queue

- [x] 3.1 Add `event` field to `HttpTriggerDefinition` in `packages/runtime/src/triggers/http.ts`
- [x] 3.2 Update `packages/runtime/src/main.ts` to create `InMemoryEventQueue`, construct events in the onTrigger callback, and enqueue them
