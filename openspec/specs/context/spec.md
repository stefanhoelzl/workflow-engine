# Context Specification

## Purpose

Provide context objects that wrap event queue access and metadata propagation, giving triggers and actions a clean interface for emitting events with proper correlation and parent tracking.

### Requirement: Context interface with emit

The system SHALL provide a `Context` interface with a single method `emit(type: string, payload: unknown): Promise<void>` that creates a new event and enqueues it.

#### Scenario: Emit creates and enqueues an event

- **GIVEN** a context instance with access to the event queue
- **WHEN** `ctx.emit("order.validated", { orderId: "abc" })` is called
- **THEN** a new event is enqueued with `type: "order.validated"` and `payload: { orderId: "abc" }`
- **AND** the event has a unique `evt_`-prefixed id
- **AND** the event has `targetAction: undefined` (goes through dispatch)
- **AND** the event has a `createdAt` timestamp

### Requirement: HttpTriggerContext

The system SHALL provide an `HttpTriggerContext` implementing `Context` that carries the parsed request body and the trigger definition.

#### Scenario: HttpTriggerContext properties

- **GIVEN** an HTTP POST to `/webhooks/order` with body `{ orderId: "abc" }`
- **AND** a trigger definition with path `"order"`, method `"POST"`, event `"order.received"`
- **WHEN** an `HttpTriggerContext` is created
- **THEN** `ctx.request` contains `{ body: { orderId: "abc" } }`
- **AND** `ctx.definition` contains the trigger definition

#### Scenario: HttpTriggerContext emit creates root event

- **GIVEN** an `HttpTriggerContext` with no parent event
- **WHEN** `ctx.emit("order.received", { orderId: "abc" })` is called
- **THEN** the enqueued event has a new `corr_`-prefixed `correlationId`
- **AND** `parentEventId` is `undefined`

### Requirement: ActionContext

The system SHALL provide an `ActionContext` implementing `Context` that carries the source event being processed.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object

#### Scenario: ActionContext emit creates child event

- **GIVEN** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** the enqueued event inherits `correlationId: "corr_xyz"`
- **AND** `parentEventId` is set to `"evt_001"`

#### Scenario: ActionContext emit multiple events

- **GIVEN** an `ActionContext` for event `evt_001`
- **WHEN** the action calls `ctx.emit()` twice with different types
- **THEN** two separate events are enqueued
- **AND** both inherit the same `correlationId` from `evt_001`
- **AND** both have `parentEventId` set to `"evt_001"`

### Requirement: ContextFactory

The system SHALL provide a `ContextFactory` class that holds a queue reference and exposes `httpTrigger` and `action` as arrow properties for creating context objects.

#### Scenario: Create HttpTriggerContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue
- **WHEN** `factory.httpTrigger(body, definition)` is called
- **THEN** an `HttpTriggerContext` is returned with the request body, definition, and a working `emit()` method

#### Scenario: Create ActionContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue
- **WHEN** `factory.action(event)` is called
- **THEN** an `ActionContext` is returned with the source event and a working `emit()` method

#### Scenario: Factory properties can be passed as standalone references

- **GIVEN** a `ContextFactory` instance
- **WHEN** `factory.httpTrigger` is assigned to a variable and called
- **THEN** it works correctly without explicit binding (arrow property captures `this`)
