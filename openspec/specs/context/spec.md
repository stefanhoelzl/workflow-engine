# Context Specification

## Purpose

Provide context objects that wrap event queue access and metadata propagation, giving triggers and actions a clean interface for emitting events with proper correlation and parent tracking.
## Requirements
### Requirement: ActionContext

The system SHALL provide an `ActionContext` that carries the source event being processed and an injected env record exposing environment variables.

The `ActionContext.emit()` method SHALL accept `(type: string, payload: unknown)` and delegate to `EventSource.derive()`. There SHALL be no `EmitOptions` parameter.

The runtime's `ActionContext` uses the internal `Event` type (with `type` field). At the SDK boundary, the runtime maps `event.type` to `event.name` when passing context to SDK-defined action handlers, producing an `EventDefinition` with `{ name, payload }`.

Network access SHALL be provided by the global `fetch` function (a polyfill), not by a method on `ActionContext`.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **AND** an env record `{ "API_KEY": "secret" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object with `type` field
- **AND** `ctx.env` is `{ "API_KEY": "secret" }`
- **AND** `ctx` SHALL NOT have a `fetch` property

#### Scenario: ActionContext emit creates child event

- **GIVEN** an `ActionContext` for event `evt_001` with `correlationId: "corr_xyz"`
- **WHEN** `ctx.emit("order.validated", { valid: true })` is called
- **THEN** `EventSource.derive()` is called with the parent event, type, and payload
- **AND** the derived event is automatically emitted to the bus

### Requirement: ActionContext env property

The `ActionContext` SHALL provide an `env` property that gives access to environment variables. The `env` property SHALL be typed as `Record<string, string>` (no `undefined`). The env values SHALL be the per-action resolved values from the workflow manifest, not `process.env`.

#### Scenario: Access environment variable

- **GIVEN** an `ActionContext` created with env `{ "API_KEY": "secret", "BASE_URL": "https://example.com" }`
- **WHEN** the handler accesses `ctx.env.API_KEY`
- **THEN** the value is `"secret"`

#### Scenario: Env does not contain undeclared variables

- **GIVEN** an `ActionContext` created with env `{ "API_KEY": "secret" }`
- **AND** `process.env.OTHER_VAR` is `"other"`
- **WHEN** the handler accesses `ctx.env`
- **THEN** `ctx.env` SHALL NOT contain `OTHER_VAR`

### Requirement: createActionContext factory function

The system SHALL provide a `createActionContext(source: EventSource, logger: Logger)` function that returns `(event: RuntimeEvent, actionName: string, env: Record<string, string>) => ActionContext`. The factory SHALL NOT accept a fetch parameter. The factory SHALL NOT accept a global env parameter; env SHALL be provided per-invocation.

#### Scenario: Create action context factory

- **GIVEN** an EventSource and Logger
- **WHEN** `createActionContext(source, logger)` is called
- **THEN** a function is returned that accepts a RuntimeEvent, action name, and per-action env record, and returns an ActionContext

#### Scenario: Factory function produces working ActionContext with per-action env

- **GIVEN** a context factory created via `createActionContext(source, logger)`
- **AND** a RuntimeEvent `evt_001` and env `{ "KEY": "value" }`
- **WHEN** `factory(evt_001, "myAction", { "KEY": "value" })` is called
- **THEN** the returned ActionContext has `event` set to `evt_001`, working `emit()`, and `env` set to `{ "KEY": "value" }`

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §2 Sandbox Boundary`. `ActionContext` carries read-side data
(`event`, `env`) across the sandbox boundary; the write-side bridge (`emit`)
is owned by the `sandbox` capability via per-run host methods.

Lifecycle and security guarantees about the sandbox itself are codified in
the `sandbox` capability spec, not here. This spec describes only the shape
of the ctx value that the runtime composes and passes to `Sandbox.run()`.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, alter what crosses the sandbox boundary (for
example by adding a new `ctx.*` field or extending payload shapes), or
conflict with the rules listed in `/SECURITY.md §2` MUST update
`/SECURITY.md §2` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §2`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §2`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §2`
- **THEN** no update to `/SECURITY.md §2` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked

