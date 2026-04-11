# SDK Specification

## Purpose

Provide the TypeScript API for defining events, wiring workflows, and typing action handlers. The SDK is a build-time-only dependency — no SDK code ships in the bundled action files.

## Requirements

### Requirement: Zod v4 dependency

The SDK SHALL depend on `zod@^4.0.0` and import the Zod API from `"zod"`. The `z` namespace SHALL be re-exported for workflow authors.

#### Scenario: Workflow authors use Zod v4 API

- **GIVEN** a workflow file that imports `z` from `@workflow-engine/sdk`
- **WHEN** the author uses `z.object()`, `z.string()`, `z.enum()`, `z.nullable()`
- **THEN** these SHALL be Zod v4 functions

### Requirement: createWorkflow requires a name argument

The `createWorkflow()` function SHALL accept a required first argument: the workflow name as a `string`. This name SHALL be included in the compiled manifest's `name` field.

#### Scenario: Workflow created with name

- **WHEN** `createWorkflow("cronitor")` is called
- **THEN** the workflow builder SHALL store the name "cronitor"
- **AND** the compiled manifest SHALL contain `name: "cronitor"`

#### Scenario: Workflow created without name

- **WHEN** `createWorkflow()` is called without a name argument
- **THEN** it SHALL fail with a TypeScript type error at compile time

### Requirement: ActionContext type in SDK

The SDK's `ActionContext` type SHALL include `event`, `env`, and `emit`. It SHALL NOT include a `fetch` property. Network access is provided by the global `fetch` function (a polyfill), not by a method on the context.

#### Scenario: ActionContext type has no fetch

- **GIVEN** a workflow action handler typed with the SDK's `ActionContext`
- **WHEN** the handler attempts to access `ctx.fetch`
- **THEN** TypeScript SHALL report a type error (property does not exist)

#### Scenario: ActionContext type has emit and env

- **GIVEN** a workflow action handler typed with the SDK's `ActionContext`
- **WHEN** the handler accesses `ctx.emit` and `ctx.env`
- **THEN** both are properly typed and accessible
