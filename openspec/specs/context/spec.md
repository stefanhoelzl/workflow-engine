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

The system SHALL provide an `ActionContext` implementing `Context` that carries the source event being processed and an injected fetch function for outbound HTTP requests.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object
- **AND** `ctx.fetch` is a callable function

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

### Requirement: ActionContext fetch method

The system SHALL provide a `fetch(url: string | URL, init?: RequestInit): Promise<Response>` method on `ActionContext` that delegates to an injected fetch function.

#### Scenario: Action performs a GET request

- **GIVEN** an `ActionContext` with an injected fetch function
- **WHEN** `ctx.fetch("https://api.example.com/orders/123")` is called
- **THEN** the injected fetch function is called with `"https://api.example.com/orders/123"` and `undefined`
- **AND** the native `Response` is returned to the caller

#### Scenario: Action performs a POST request with options

- **GIVEN** an `ActionContext` with an injected fetch function
- **WHEN** `ctx.fetch("https://api.example.com/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "123" }) })` is called
- **THEN** the injected fetch function is called with the URL and the full `RequestInit` options
- **AND** the native `Response` is returned to the caller

#### Scenario: Fetch error propagates to action

- **GIVEN** an `ActionContext` with an injected fetch function that rejects
- **WHEN** `ctx.fetch("https://unreachable.example.com")` is called
- **THEN** the promise rejects with the same error from the injected function
- **AND** the action can catch the error or let it propagate to the scheduler

### Requirement: ContextFactory

The system SHALL provide a `ContextFactory` class that holds a queue reference, an injected fetch function, and a Logger instance. It SHALL expose `httpTrigger` and `action` as arrow properties for creating context objects. The Logger SHALL be passed via the constructor.

#### Scenario: Create HttpTriggerContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue, a fetch function, and a Logger
- **WHEN** `factory.httpTrigger(body, definition)` is called
- **THEN** an `HttpTriggerContext` is returned with the request body, definition, and a working `emit()` method

#### Scenario: Create ActionContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue, a fetch function, and a Logger
- **WHEN** `factory.action(event)` is called
- **THEN** an `ActionContext` is returned with the source event, a working `emit()` method, and the injected fetch function

#### Scenario: Factory properties can be passed as standalone references

- **GIVEN** a `ContextFactory` instance
- **WHEN** `factory.httpTrigger` is assigned to a variable and called
- **THEN** it works correctly without explicit binding (arrow property captures `this`)

### Requirement: ContextFactory emit logging

The `ContextFactory.#createAndEnqueue` method SHALL log every event creation. This covers all emits from both `HttpTriggerContext` and `ActionContext` in a single location.

#### Scenario: Root event emitted from trigger

- **GIVEN** a `ContextFactory` with a Logger
- **AND** an `HttpTriggerContext` created by the factory
- **WHEN** `ctx.emit("order.received", { orderId: "abc" })` is called
- **THEN** `event.emitted` is logged at info level with correlationId, type `"order.received"`, and the new eventId
- **AND** `event.emitted.payload` is logged at trace level with the full payload

#### Scenario: Child event emitted from action

- **GIVEN** a `ContextFactory` with a Logger
- **AND** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** `event.emitted` is logged at info level with correlationId `"corr_xyz"`, type `"order.validated"`, the new eventId, and parentEventId `"evt_001"`
- **AND** `event.emitted.payload` is logged at trace level with the full payload

#### Scenario: Targeted event includes targetAction in log

- **GIVEN** a `ContextFactory` with a Logger
- **WHEN** an event is emitted with `targetAction: "notify"`
- **THEN** `event.emitted` log entry includes `targetAction: "notify"`

### Requirement: ActionContext fetch logging

The `ActionContext.fetch` method SHALL log the request lifecycle. The Logger SHALL be provided to `ActionContext` via the `ContextFactory`.

#### Scenario: Successful fetch is logged

- **GIVEN** an `ActionContext` with a Logger and an injected fetch that returns status 200
- **WHEN** `ctx.fetch("https://api.example.com/orders/123")` is called
- **THEN** `fetch.start` is logged at info level with correlationId, url, and method
- **AND** `fetch.completed` is logged at info level with correlationId, url, status, and duration in ms
- **AND** the Response is returned to the caller

#### Scenario: Fetch with request body logs payload at trace level

- **GIVEN** an `ActionContext` with a Logger at trace level
- **WHEN** `ctx.fetch("https://api.example.com/orders", { method: "POST", body: JSON.stringify({ id: "123" }) })` is called
- **THEN** `fetch.request.body` is logged at trace level with the body content

#### Scenario: Failed fetch is logged

- **GIVEN** an `ActionContext` with a Logger and an injected fetch that rejects with an error
- **WHEN** `ctx.fetch("https://unreachable.example.com")` is called
- **THEN** `fetch.start` is logged at info level
- **AND** `fetch.failed` is logged at error level with correlationId, url, error message, and duration
- **AND** the promise rejects with the same error from the injected function
