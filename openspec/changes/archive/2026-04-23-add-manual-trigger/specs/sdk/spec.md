# SDK Delta

## MODIFIED Requirements

### Requirement: Brand symbols identify SDK products

The SDK SHALL export five brand symbols used to identify objects produced by its factories:
- `ACTION_BRAND = Symbol.for("@workflow-engine/action")`
- `HTTP_TRIGGER_BRAND = Symbol.for("@workflow-engine/http-trigger")`
- `CRON_TRIGGER_BRAND = Symbol.for("@workflow-engine/cron-trigger")`
- `MANUAL_TRIGGER_BRAND = Symbol.for("@workflow-engine/manual-trigger")`
- `WORKFLOW_BRAND = Symbol.for("@workflow-engine/workflow")`

The SDK SHALL provide type guards `isAction(value)`, `isHttpTrigger(value)`, `isCronTrigger(value)`, `isManualTrigger(value)`, `isWorkflow(value)` that check for the corresponding brand symbol.

#### Scenario: Brand on each factory return value

- **WHEN** `action(...)`, `httpTrigger(...)`, `cronTrigger(...)`, `manualTrigger(...)`, or `defineWorkflow(...)` is called
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
- **AND** `isManualTrigger(v)` SHALL return `false`

#### Scenario: isManualTrigger recognizes manual trigger values

- **GIVEN** a value `v` returned from `manualTrigger({...})`
- **WHEN** `isManualTrigger(v)` is called
- **THEN** the function SHALL return `true`
- **AND** `isHttpTrigger(v)` SHALL return `false`
- **AND** `isCronTrigger(v)` SHALL return `false`

## ADDED Requirements

### Requirement: manualTrigger factory

The SDK SHALL export a `manualTrigger(config)` factory returning a callable `ManualTrigger` value, following the same callable+branded pattern as `httpTrigger` and `cronTrigger`. Full semantics are defined in the `manual-trigger` capability spec. This requirement exists in the `sdk` capability to establish that the factory is part of the SDK's public API surface and is re-exported alongside `httpTrigger`, `cronTrigger`, and `action`.

The factory config SHALL accept an optional `input` Zod schema, an optional `output` Zod schema, and a required `handler`. When `input` is omitted, the SDK factory SHALL use `z.object({})`; when `output` is omitted, the SDK factory SHALL use `z.unknown()`.

#### Scenario: manualTrigger exported from SDK root

- **WHEN** a workflow file imports `{ manualTrigger } from "@workflow-engine/sdk"`
- **THEN** the factory SHALL be available
- **AND** calling `manualTrigger({ handler: async () => {} })` SHALL return a branded callable

#### Scenario: manualTrigger exposes default schemas

- **GIVEN** `const t = manualTrigger({ handler: async () => {} })`
- **WHEN** `t.inputSchema` and `t.outputSchema` are inspected
- **THEN** `t.inputSchema` SHALL be `z.object({})` (or its structural equivalent)
- **AND** `t.outputSchema` SHALL be `z.unknown()` (or its structural equivalent)

#### Scenario: manualTrigger preserves author-provided schemas

- **GIVEN** `manualTrigger({ input: z.object({ id: z.string() }), output: z.number(), handler })`
- **WHEN** the returned value's schemas are inspected
- **THEN** `inputSchema` SHALL correspond to `z.object({ id: z.string() })`
- **AND** `outputSchema` SHALL correspond to `z.number()`
