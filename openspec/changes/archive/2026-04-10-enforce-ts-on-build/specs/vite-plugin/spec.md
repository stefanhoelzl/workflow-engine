## MODIFIED Requirements

### Requirement: Build failure on validation errors

The plugin SHALL fail the Vite build if a workflow has validation errors during `.compile()` or if TypeScript type checking detects errors in workflow files during production builds.

#### Scenario: Action references undefined event
- **WHEN** a workflow's `.compile()` throws because an action references an event not defined via `.event()`
- **THEN** the Vite build SHALL fail with an error message identifying the workflow and the error

#### Scenario: Unmatched handler export
- **WHEN** `.compile()` returns an action whose handler reference does not match any named export
- **THEN** the Vite build SHALL fail with an error identifying the unmatched action

#### Scenario: TypeScript type error in workflow
- **WHEN** a workflow file contains a TypeScript type error
- **AND** the build is not in watch mode
- **THEN** the Vite build SHALL fail during `buildStart` with formatted type error diagnostics
- **AND** the error SHALL be reported before any bundling occurs
