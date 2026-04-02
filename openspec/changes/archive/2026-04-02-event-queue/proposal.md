## Why

The HTTP trigger currently fires into a `console.log`. For the system to do anything useful, trigger payloads need to become events in a queue. This is the next minimal step toward the Trigger → Event → Action pipeline: connecting the trigger output to a queue input.

## What Changes

- Add `event` field to `HttpTriggerDefinition` — the trigger declares which event type it produces
- Introduce `Event` type — a minimal event shape with `id`, `type`, `payload`, `createdAt`
- Introduce `EventQueue` interface with a single `enqueue` method
- Introduce `InMemoryEventQueue` as the first implementation (temporary, later becomes the test double)
- Wire the `onTrigger` callback in `main.ts` to construct an event and enqueue it

## Capabilities

### New Capabilities
- `event-queue`: Event type definition, queue interface for adding events, and in-memory implementation

### Modified Capabilities

None.

## Impact

- **No new dependencies** — uses `crypto.randomUUID()` for ID generation
- **New directory**: `packages/runtime/src/event-queue/` with `index.ts` and `in-memory.ts`
- **Modified file**: `packages/runtime/src/triggers/http.ts` — adds `event` field to `HttpTriggerDefinition`
- **Modified file**: `packages/runtime/src/main.ts` — replaces `console.log` with event creation + enqueue
- **No effect** on triggers, server, sandbox, SDK, or build pipeline
- **No tests for InMemoryEventQueue** — it is an intermediate implementation that will later serve as a test double
