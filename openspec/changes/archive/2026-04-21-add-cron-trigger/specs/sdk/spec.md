## MODIFIED Requirements

### Requirement: Brand symbols identify SDK products

The SDK SHALL export four brand symbols used to identify objects produced by its factories:
- `ACTION_BRAND = Symbol.for("@workflow-engine/action")`
- `HTTP_TRIGGER_BRAND = Symbol.for("@workflow-engine/http-trigger")`
- `CRON_TRIGGER_BRAND = Symbol.for("@workflow-engine/cron-trigger")`
- `WORKFLOW_BRAND = Symbol.for("@workflow-engine/workflow")`

The SDK SHALL provide type guards `isAction(value)`, `isHttpTrigger(value)`, `isCronTrigger(value)`, `isWorkflow(value)` that check for the corresponding brand symbol.

#### Scenario: Brand on each factory return value

- **WHEN** `action(...)`, `httpTrigger(...)`, `cronTrigger(...)`, or `defineWorkflow(...)` is called
- **THEN** the returned value SHALL have the corresponding brand symbol set to `true`

#### Scenario: Type guard recognizes branded value

- **GIVEN** a value `v` returned from `action({...})`
- **WHEN** `isAction(v)` is called
- **THEN** the function SHALL return `true`

#### Scenario: Type guard rejects unrelated value

- **GIVEN** a plain function `() => 1`
- **WHEN** `isAction(value)` is called
- **THEN** the function SHALL return `false`

#### Scenario: isCronTrigger recognizes cron trigger values

- **GIVEN** a value `v` returned from `cronTrigger({...})`
- **WHEN** `isCronTrigger(v)` is called
- **THEN** the function SHALL return `true`
- **AND** `isHttpTrigger(v)` SHALL return `false`

## ADDED Requirements

### Requirement: cronTrigger factory

The SDK SHALL export a `cronTrigger(config)` factory returning a callable `CronTrigger` value, following the same callable+branded pattern as `httpTrigger`. Full semantics are defined in the `cron-trigger` capability spec. This requirement exists in the `sdk` capability to establish that the factory is part of the SDK's public API surface and is re-exported alongside `httpTrigger` and `action`.

The SDK SHALL constrain the `schedule` field's TypeScript type using `ts-cron-validator`'s `validStandardCronExpression` template-literal type so that invalid cron expressions fail at compile time without executing runtime validation.

#### Scenario: cronTrigger exported from SDK root

- **WHEN** a workflow file imports `{ cronTrigger } from "@workflow-engine/sdk"`
- **THEN** the factory SHALL be available
- **AND** calling `cronTrigger({ schedule: "0 9 * * *", handler })` SHALL return a branded callable

#### Scenario: Invalid cron string fails at type level

- **GIVEN** `cronTrigger({ schedule: "invalid", handler: async () => {} })`
- **WHEN** the workflow file is type-checked
- **THEN** TypeScript SHALL reject the call with a type error on `schedule`
