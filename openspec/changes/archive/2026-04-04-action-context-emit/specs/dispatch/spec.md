## MODIFIED Requirements

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
