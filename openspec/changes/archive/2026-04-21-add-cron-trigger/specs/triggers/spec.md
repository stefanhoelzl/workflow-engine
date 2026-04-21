## MODIFIED Requirements

### Requirement: Trigger is an abstract umbrella

The `Trigger` type SHALL be an abstract umbrella defined as a TypeScript union of concrete trigger implementations. In v1 post-this-change the union contains two members: `HttpTrigger | CronTrigger`. The `Trigger` type SHALL be used by runtime dispatch and the workflow registry; authors SHALL NOT write `Trigger` directly. Each concrete trigger type SHALL ship its own SDK factory (e.g., `httpTrigger(...)`, `cronTrigger(...)`), its own brand symbol, and its own concrete type.

#### Scenario: Trigger union includes HttpTrigger and CronTrigger

- **GIVEN** the SDK's `Trigger` umbrella type
- **WHEN** the type is inspected
- **THEN** the `Trigger` union SHALL equal `HttpTrigger | CronTrigger`
- **AND** existing `HttpTrigger` consumers SHALL continue to compile without change

#### Scenario: Trigger union grows by union member

- **GIVEN** a future change introducing a third trigger kind (e.g., `MailTrigger`)
- **WHEN** the new trigger type is added
- **THEN** the `Trigger` union SHALL be extended to `HttpTrigger | CronTrigger | MailTrigger`
- **AND** existing consumers SHALL continue to compile without change
