# Triggers Delta

## MODIFIED Requirements

### Requirement: Trigger is an abstract umbrella

The `Trigger` type SHALL be an abstract umbrella defined as a TypeScript union of concrete trigger implementations. After this change the union contains three members: `HttpTrigger | CronTrigger | ManualTrigger`. The `Trigger` type SHALL be used by runtime dispatch and the workflow registry; authors SHALL NOT write `Trigger` directly. Each concrete trigger type SHALL ship its own SDK factory (e.g., `httpTrigger(...)`, `cronTrigger(...)`, `manualTrigger(...)`), its own brand symbol, and its own concrete type.

#### Scenario: Trigger union includes HttpTrigger, CronTrigger, and ManualTrigger

- **GIVEN** the SDK's `Trigger` umbrella type
- **WHEN** the type is inspected
- **THEN** the `Trigger` union SHALL equal `HttpTrigger | CronTrigger | ManualTrigger`
- **AND** existing `HttpTrigger` and `CronTrigger` consumers SHALL continue to compile without change

#### Scenario: Trigger union grows by union member

- **GIVEN** a future change introducing a fourth trigger kind (e.g., `MailTrigger`)
- **WHEN** the new trigger type is added
- **THEN** the `Trigger` union SHALL be extended to `HttpTrigger | CronTrigger | ManualTrigger | MailTrigger`
- **AND** existing consumers SHALL continue to compile without change

## ADDED Requirements

### Requirement: Manual kind registered with a backend

The runtime's backend set SHALL include a `TriggerSource<"manual">` registered alongside the HTTP and cron backends. `reconfigureBackends` SHALL partition manifest trigger entries by `kind` and dispatch manual entries to the registered manual backend. If the manual backend is absent at runtime, `reconfigureBackends` SHALL classify the failure the same way it classifies an unknown kind (per the existing `action-upload` contract: `422` with a manifest-rejection error).

The manual backend's `reconfigure(tenant, entries)` SHALL always return `{ ok: true }` and SHALL NOT retain the entries, because the manual-fire path resolves entries directly from the workflow registry (`registry.getEntry`) rather than from any backend-held index.

#### Scenario: reconfigureBackends dispatches manual entries to the manual backend

- **GIVEN** a tenant manifest containing one http, one cron, and one manual trigger
- **WHEN** `reconfigureBackends(tenant, state)` is called
- **THEN** the http entry SHALL be dispatched to the HTTP backend
- **AND** the cron entry SHALL be dispatched to the cron backend
- **AND** the manual entry SHALL be dispatched to the manual backend
- **AND** each backend SHALL return `{ ok: true }` (the manual backend unconditionally so)

#### Scenario: Manual backend participates in ReconfigureResult aggregation

- **GIVEN** an upload that triggers `reconfigureBackends` for three kinds
- **WHEN** all backends resolve to `{ ok: true }`
- **THEN** the aggregated result SHALL be `{ ok: true }`
- **AND** the tarball SHALL be persisted

#### Scenario: Manual backend state survives reconfigure calls without allocation

- **GIVEN** a manual backend that has been `reconfigure`d many times across many tenants
- **WHEN** the backend is inspected
- **THEN** the backend SHALL hold no per-tenant map or index
- **AND** the backend SHALL hold no timer or middleware registration
