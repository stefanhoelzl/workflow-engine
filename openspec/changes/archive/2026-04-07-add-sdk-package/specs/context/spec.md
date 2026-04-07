## MODIFIED Requirements

### Requirement: ActionContext

The system SHALL provide an `ActionContext` implementing `Context` that carries the source event being processed, an injected fetch function for outbound HTTP requests, and access to environment variables.

The runtime's `ActionContext` uses the internal `Event` type (with `type` field). At the SDK boundary, the runtime maps `event.type` to `event.name` when passing context to SDK-defined action handlers, producing an `EventDefinition` with `{ name, payload }`.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object with `type` field
- **AND** `ctx.fetch` is a callable function
- **AND** `ctx.env` provides access to environment variables

#### Scenario: SDK handler receives mapped event

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **WHEN** the runtime invokes the SDK-defined handler
- **THEN** the handler receives `ctx.event` as `{ name: "order.received", payload: { orderId: "abc" } }`

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

### Requirement: ActionContext env property

The `ActionContext` SHALL provide an `env` property that gives access to environment variables. The `env` property SHALL be typed as `Record<string, string | undefined>`.

#### Scenario: Access environment variable

- **GIVEN** an `ActionContext` with env containing `DATABASE_URL=postgres://localhost/db`
- **WHEN** the handler accesses `ctx.env.DATABASE_URL`
- **THEN** the value is `"postgres://localhost/db"`

### Requirement: HttpTriggerContext uses HttpTriggerResolved

The `HttpTriggerContext` SHALL use the `HttpTriggerResolved` type (with defaults applied) rather than the raw `HttpTriggerDefinition`.

#### Scenario: HttpTriggerContext receives resolved definition

- **GIVEN** an HTTP trigger registered with only `path` and `event`
- **WHEN** an `HttpTriggerContext` is created after lookup
- **THEN** `ctx.definition` has `method: "POST"` and `response: { status: 200, body: "" }`
