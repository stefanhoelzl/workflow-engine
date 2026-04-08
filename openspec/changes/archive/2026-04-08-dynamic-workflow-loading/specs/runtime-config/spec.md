## ADDED Requirements

### Requirement: WORKFLOW_DIR config variable
The config schema SHALL include a `WORKFLOW_DIR` field that accepts a string path. It SHALL have no default value and SHALL be required.

#### Scenario: WORKFLOW_DIR is set
- **WHEN** `createConfig` is called with `{ WORKFLOW_DIR: "/app/workflows" }`
- **THEN** it SHALL return a config with `workflowDir` set to `"/app/workflows"`

#### Scenario: WORKFLOW_DIR is not set
- **WHEN** `createConfig` is called without `WORKFLOW_DIR`
- **THEN** it SHALL throw a validation error
