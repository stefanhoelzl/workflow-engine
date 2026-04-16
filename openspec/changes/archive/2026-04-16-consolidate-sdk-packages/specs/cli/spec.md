## MODIFIED Requirements

### Requirement: Build pipeline
The CLI builds workflows using the vite plugin imported from `@workflow-engine/sdk/plugin` (previously `@workflow-engine/vite-plugin`). Output is written to `<cwd>/dist/<name>/bundle.tar.gz` for each workflow. Does NOT support user-authored `vite.config.ts`.

#### Scenario: CLI uses SDK-internal plugin
- **WHEN** the CLI's vite-config module imports the plugin
- **THEN** it imports from the SDK's internal plugin module (not a separate package)

### Requirement: CLI code lives in SDK
The CLI source code SHALL live inside `@workflow-engine/sdk` at `src/cli/`. The standalone `@workflow-engine/cli` package SHALL be deleted. The `wfe` binary is provided by SDK's `bin` field.

#### Scenario: Standalone package removed
- **WHEN** inspecting the packages directory
- **THEN** `packages/cli/` does not exist

#### Scenario: CLI source lives in SDK
- **WHEN** inspecting the SDK package
- **THEN** `packages/sdk/src/cli/` contains the CLI source files (cli.ts, build.ts, upload.ts, vite-config.ts)

### Requirement: Programmatic API
The SDK SHALL export `build`, `upload`, `NoWorkflowsFoundError`, `UploadOptions`, and `UploadResult` from the `./cli` subpath export. The `scripts/dev.ts` and any other programmatic consumers SHALL import from `@workflow-engine/sdk/cli`.

#### Scenario: Importing programmatic API
- **WHEN** a script imports `{ upload } from "@workflow-engine/sdk/cli"`
- **THEN** it receives the same `upload` function as the previous `@workflow-engine/cli` package
