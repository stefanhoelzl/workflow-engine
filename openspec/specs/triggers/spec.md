# Triggers Specification

## Purpose

Define the abstract trigger umbrella type and the contract for concrete trigger implementations. Triggers receive external stimuli and drive invocation lifecycle via the executor.

## Requirements

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

### Requirement: Trigger has exactly one handler

A trigger SHALL declare exactly one `handler` function. There are no subscribers, no fan-out, and no `emit()` from inside trigger handlers in v1. The handler's return value SHALL be the basis for the trigger source's response (HTTP response for `HttpTrigger`).

#### Scenario: Trigger declares one handler

- **GIVEN** any concrete trigger factory
- **WHEN** the trigger is created
- **THEN** the trigger SHALL carry exactly one `handler` function

### Requirement: Native implementation

Triggers SHALL be implemented as part of the platform runtime, not as user-provided sandboxed code. Concrete implementations bind to their own ingress mechanisms (HTTP server for `HttpTrigger`).

#### Scenario: Trigger source bound at startup

- **GIVEN** the runtime starts with one or more HTTP triggers configured
- **WHEN** the runtime initializes
- **THEN** the HTTP server SHALL bind its port and register routes for each HTTP trigger
