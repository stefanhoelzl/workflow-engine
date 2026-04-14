## MODIFIED Requirements

### Requirement: ActionContext

The system SHALL provide an `ActionContext` that carries the source event being processed and an injected env record exposing environment variables.

`ActionContext` SHALL expose `event` and `env` only. It SHALL NOT have an `emit` method. Event emission from within a workflow action is performed by the global `emit(type, payload)` host method installed by the runtime as a per-run extra method on the sandbox (see `sandbox` capability).

The runtime's `ActionContext` uses the internal `Event` type (with `type` field). At the SDK boundary, the runtime maps `event.type` to `event.name` when composing the ctx JSON passed to `Sandbox.run()`, producing an `EventDefinition` with `{ name, payload }`.

Network access SHALL be provided by the global `fetch` function (a polyfill), not by a method on `ActionContext`.

#### Scenario: ActionContext properties

- **GIVEN** an action processing event `evt_001` with `type: "order.received"` and `payload: { orderId: "abc" }`
- **AND** an env record `{ "API_KEY": "secret" }`
- **WHEN** an `ActionContext` is created
- **THEN** `ctx.event` is the full source event object with `type` field
- **AND** `ctx.env` is `{ "API_KEY": "secret" }`
- **AND** `ctx` SHALL NOT have a `fetch` property
- **AND** `ctx` SHALL NOT have an `emit` method

#### Scenario: Emit is a global inside the sandbox

- **GIVEN** a workflow action executing inside the sandbox
- **WHEN** the action calls `emit("order.validated", { valid: true })`
- **THEN** the runtime's per-run `emit` host method SHALL be invoked with `("order.validated", { valid: true })`
- **AND** the emit closure SHALL call `EventSource.derive()` with the parent event, type, and payload
- **AND** the derived event SHALL be emitted to the bus

### Requirement: createActionContext factory function

The system SHALL provide a `createActionContext()` function that returns a factory producing `ActionContext` values for a given `(event, actionName, env)` triple.

The factory SHALL NOT depend on `EventSource` for constructing `ActionContext` itself (since `ActionContext` no longer owns `emit`). The runtime composes the `emit` closure separately at dispatch time and passes it to `Sandbox.run()` as a per-run extra method.

`ActionContext` SHALL be a plain record `{ event, env }`. The factory SHALL be trivially constructible without external dependencies.

#### Scenario: Factory returns ActionContext with event and env

- **GIVEN** a RuntimeEvent `evt_001` and env `{ "KEY": "value" }`
- **WHEN** the factory is called with `(evt_001, "myAction", { "KEY": "value" })`
- **THEN** the returned `ActionContext` has `event` set to `evt_001` and `env` set to `{ "KEY": "value" }`
- **AND** the returned `ActionContext` SHALL NOT have an `emit` method

## MODIFIED Requirements

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
