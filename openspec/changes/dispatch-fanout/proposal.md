## Why

The dispatch action is infrastructure masquerading as a user action — it has special matching logic (`targetAction === undefined`), skips itself in its own loop, and uses synthetic events to discover subscribers. This leaky abstraction muddies the action model. Fan-out is a routing concern that belongs in the scheduler, and event construction logic is duplicated between `ContextFactory` and the dispatch action.

## What Changes

- **Remove the dispatch action** entirely (`actions/dispatch.ts`). Fan-out is no longer modeled as an action.
- **Move fan-out into the scheduler**. When the scheduler dequeues an event without `targetAction`, it finds matching actions by comparing `event.type` against each action's `on` field, creates a targeted copy per match, emits each copy as `pending` via the EventBus, and transitions the original to `done` (or `skipped` if no actions match).
- **Simplify the Action interface**. Replace the `match` predicate with a declarative `on: string` field. Remove the `match` function entirely — the scheduler routes directed events by checking `action.name === event.targetAction && action.on === event.type`.
- **Extract an EventFactory** from `ContextFactory` with three methods:
  - `create(type, payload, correlationId)` — validates payload, returns new `RuntimeEvent`. Used by triggers.
  - `derive(parent, type, payload)` — validates payload, inherits `correlationId`, sets `parentEventId`. Used by actions emitting new events.
  - `fork(parent, { targetAction })` — no validation, copies type/payload/correlationId from parent, sets `parentEventId` and `targetAction`. Used by scheduler fan-out.
- **Simplify ContextFactory** to delegate event construction to `EventFactory` instead of owning it.

## Capabilities

### New Capabilities
- `event-factory`: Centralized RuntimeEvent construction with three creation modes (create, derive, fork), payload validation, and metadata propagation.

### Modified Capabilities
- `dispatch`: **BREAKING** — Removed entirely. Fan-out moves to the scheduler.
- `scheduler`: Gains fan-out responsibility for undirected events. Routes directed events by `action.name` + `action.on` instead of `action.match()`.
- `actions`: **BREAKING** — Action interface changes from `{ name, match, handler }` to `{ name, on, handler }`.
- `context`: ContextFactory delegates event construction to EventFactory. No longer owns `#createAndEmit` logic directly.

## Impact

- `packages/runtime/src/actions/dispatch.ts` — deleted
- `packages/runtime/src/actions/dispatch.test.ts` — deleted
- `packages/runtime/src/actions/index.ts` — Action interface: remove `match`, add `on`
- `packages/runtime/src/services/scheduler.ts` — fan-out logic, routing by name+on
- `packages/runtime/src/services/scheduler.test.ts` — new fan-out tests, update routing tests
- `packages/runtime/src/context/index.ts` — delegate to EventFactory
- `packages/runtime/src/main.ts` — remove dispatch action creation, set `on` on actions
- New file: `packages/runtime/src/event-factory.ts` (or similar)
- SDK unchanged — `WorkflowConfig` actions already carry `on` metadata
