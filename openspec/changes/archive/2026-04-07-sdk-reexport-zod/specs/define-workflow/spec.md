## ADDED Requirements

### Requirement: SDK re-exports Zod

The SDK SHALL re-export `z` from Zod so workflow authors can import everything from a single package.

#### Scenario: Import z from SDK

- **GIVEN** a workflow file importing from `@workflow-engine/sdk`
- **WHEN** the author writes `import { defineWorkflow, z } from "@workflow-engine/sdk"`
- **THEN** `z` is the same Zod namespace as `import { z } from "zod"`
