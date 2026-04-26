## MODIFIED Requirements

### Requirement: Trigger is an abstract umbrella

The `Trigger` type SHALL be an abstract umbrella defined as a TypeScript union of concrete trigger implementations. The union contains four members: `HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger`. The `Trigger` type SHALL be used by runtime dispatch and the workflow registry; authors SHALL NOT write `Trigger` directly. Each concrete trigger type SHALL ship its own SDK factory (e.g., `httpTrigger(...)`, `cronTrigger(...)`, `manualTrigger(...)`, `imapTrigger(...)`), its own brand symbol, and its own concrete type.

#### Scenario: Trigger union includes HttpTrigger, CronTrigger, ManualTrigger, and ImapTrigger

- **GIVEN** the SDK's `Trigger` umbrella type
- **WHEN** the type is inspected
- **THEN** the `Trigger` union SHALL equal `HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger`
- **AND** existing `HttpTrigger`, `CronTrigger`, and `ManualTrigger` consumers SHALL continue to compile without change

#### Scenario: Trigger union grows by union member

- **GIVEN** a future change introducing a fifth trigger kind
- **WHEN** the new trigger type is added
- **THEN** the `Trigger` union SHALL be extended by union-append
- **AND** existing consumers SHALL continue to compile without change
