## Why

The runtime can receive HTTP requests and enqueue events, but nothing processes them. To complete the Trigger → Event → Action pipeline for the MWE, we need a scheduler that dequeues events and runs actions, and a dispatch mechanism that fans out events to their subscribers.

## What Changes

- Add `Action` type: `{ name, match: (event) => boolean, handler: (event) => void }` — function-based matching on event properties
- Add `targetAction` field to `Event` — identifies which action should process a given event
- Implement scheduler loop: dequeue → match action → run handler → ack/fail
- Implement built-in dispatch action that fans out events without a `targetAction` by duplicating them for each subscriber
- Extend `EventQueue` interface with `dequeue`, `ack`, `fail` lifecycle methods
- Extend `InMemoryEventQueue` to implement the new methods
- Wire everything together in the runtime entry point with hardcoded action registrations (no SDK/manifest yet)

## Capabilities

### New Capabilities

- `dispatch`: Built-in dispatch action that handles fan-out by duplicating events for each registered subscriber

### Modified Capabilities

- `actions`: Add runtime `Action` type with function-based event matching (`name`, `match`, `handler`)
- `event-queue`: Add `targetAction` to `Event`, add `dequeue`/`ack`/`fail` to `EventQueue` interface and `InMemoryEventQueue`
- `scheduler`: Define the scheduler loop that dequeues events, matches them to actions, and runs handlers

## Impact

- `packages/runtime/src/event-queue/index.ts` — `Event` type gains `targetAction`, `EventQueue` interface gains new methods
- `packages/runtime/src/event-queue/in-memory.ts` — `InMemoryEventQueue` implements dequeue/ack/fail
- `packages/runtime/src/scheduler/` — new scheduler module
- `packages/runtime/src/actions/` — new action system module with `Action` type and dispatch
- `packages/runtime/src/main.ts` — wire scheduler, actions, and dispatch into the runtime
