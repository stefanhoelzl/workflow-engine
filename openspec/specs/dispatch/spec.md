# Dispatch Specification

## Purpose

Provide a built-in dispatch action that fans out undispatched events to subscriber actions by cloning the event with a targeted `targetAction` for each matching subscriber.

## Requirements

### Requirement: Dispatch is a built-in action

The system SHALL register a built-in dispatch action that matches events where `targetAction` is `undefined`.

#### Scenario: Dispatch matches raw event

- **GIVEN** the dispatch action with `match: (e) => e.targetAction === undefined`
- **WHEN** an event `{ type: "order.received", targetAction: undefined }` is dequeued
- **THEN** dispatch matches and handles the event

#### Scenario: Dispatch does not match targeted event

- **GIVEN** the dispatch action
- **WHEN** an event `{ type: "order.received", targetAction: "parseOrder" }` is dequeued
- **THEN** dispatch does not match

### Requirement: Fan-out by cloning events

The dispatch action SHALL create one new event per subscriber action using `ctx.emit()`, each with the subscriber's action name encoded in the event type or targeting metadata.

#### Scenario: Event with two subscribers

- **GIVEN** registered actions `parseOrder` and `sendEmail` that both match `type: "order.received"` (with their respective `targetAction`)
- **WHEN** dispatch handles event `evt_001` with `type: "order.received"` via its `ActionContext`
- **THEN** dispatch calls `ctx.emit()` twice, creating two new events:
  - `{ type: "order.received", targetAction: "parseOrder", payload: <same as evt_001> }`
  - `{ type: "order.received", targetAction: "sendEmail", payload: <same as evt_001> }`
- **AND** each has a unique `evt_` id
- **AND** each inherits `correlationId` from `evt_001`

### Requirement: Dispatch uses ActionContext

The dispatch action SHALL receive an `ActionContext` like any other action and use `ctx.emit()` for enqueueing fan-out events, rather than accessing the queue directly.

#### Scenario: Dispatch is a regular action

- **GIVEN** the dispatch action is created via `createDispatchAction(actions)`
- **WHEN** the scheduler processes an undispatched event
- **THEN** dispatch receives an `ActionContext`
- **AND** it uses `ctx.emit()` to create targeted events
- **AND** it does not require direct access to the event queue

### Requirement: Subscriber discovery via match functions

The dispatch action SHALL find subscribers by iterating all registered actions and testing each with a synthetic event `{ ...event, targetAction: action.name }`. If an action's `match` returns `true`, it is a subscriber.

#### Scenario: Dispatch identifies subscribers

- **GIVEN** actions `parseOrder` (matches type `"order.received"` + targetAction `"parseOrder"`), `sendEmail` (matches type `"order.received"` + targetAction `"sendEmail"`), and `updateInventory` (matches type `"order.shipped"` + targetAction `"updateInventory"`)
- **WHEN** dispatch processes an event with `type: "order.received"`
- **THEN** `parseOrder` and `sendEmail` are identified as subscribers
- **AND** `updateInventory` is not

#### Scenario: Dispatch skips itself

- **GIVEN** the dispatch action is in the action list
- **WHEN** dispatch looks for subscribers
- **THEN** it does not include itself as a subscriber (dispatch matches `targetAction: undefined`, not `targetAction: "dispatch"`)

### Requirement: Zero subscribers is not an error

The dispatch action SHALL enqueue nothing and complete successfully if no actions subscribe to the event type.

#### Scenario: Event with no subscribers

- **GIVEN** an event with `type: "audit.log"` and no registered actions matching that type
- **WHEN** dispatch handles the event
- **THEN** no new events are enqueued
- **AND** the original event is marked as done
