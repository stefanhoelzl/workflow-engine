## MODIFIED Requirements

### Requirement: ActionContext

The system SHALL provide an `ActionContext` implementing `Context` that carries the source event being processed, an injected fetch function for outbound HTTP requests, and an injected env record exposing environment variables.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **AND** an env record `{ "API_KEY": "secret" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object
- **AND** `ctx.fetch` is a callable function
- **AND** `ctx.env` is `{ "API_KEY": "secret" }`

#### Scenario: ActionContext env exposes injected record

- **GIVEN** an `ActionContext` created with env record `{ "FOO": "bar", "BAZ": "qux" }`
- **WHEN** the action reads `ctx.env.FOO`
- **THEN** the value is `"bar"`

#### Scenario: ActionContext env returns undefined for missing keys

- **GIVEN** an `ActionContext` created with env record `{ "FOO": "bar" }`
- **WHEN** the action reads `ctx.env.MISSING`
- **THEN** the value is `undefined`

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

The system SHALL provide a `ContextFactory` class that holds a queue reference, an injected fetch function, and an injected env record, and exposes `httpTrigger` and `action` as arrow properties for creating context objects.

#### Scenario: Create ActionContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue, a fetch function, and an env record `{ "API_KEY": "secret" }`
- **WHEN** `factory.action(event)` is called
- **THEN** an `ActionContext` is returned with the source event, a working `emit()` method, the injected fetch function, and `env` containing `{ "API_KEY": "secret" }`

#### Scenario: Create HttpTriggerContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue, a fetch function, and an env record
- **WHEN** `factory.httpTrigger(body, definition)` is called
- **THEN** an `HttpTriggerContext` is returned with the request body, definition, and a working `emit()` method
- **AND** `HttpTriggerContext` does NOT have an `env` property

#### Scenario: Factory properties can be passed as standalone references

- **GIVEN** a `ContextFactory` instance
- **WHEN** `factory.action` is assigned to a variable and called
- **THEN** it works correctly without explicit binding (arrow property captures `this`)
