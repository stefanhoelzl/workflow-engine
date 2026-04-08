## ADDED Requirements

### Requirement: Zod v4 dependency

The SDK SHALL depend on `zod@^4.0.0` and import the Zod API from `"zod"`. The `z` namespace SHALL be re-exported for workflow authors.

#### Scenario: Workflow authors use Zod v4 API

- **GIVEN** a workflow file that imports `z` from `@workflow-engine/sdk`
- **WHEN** the author uses `z.object()`, `z.string()`, `z.enum()`, `z.nullable()`
- **THEN** these SHALL be Zod v4 functions
