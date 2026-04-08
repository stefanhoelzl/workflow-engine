## MODIFIED Requirements

### Requirement: Build script is available from the root
The root `package.json` SHALL include a `build` script that builds the runtime via Vite and the workflows via their own Vite config.

#### Scenario: pnpm build runs successfully
- **WHEN** `pnpm build` is run from the repository root
- **THEN** the Vite SSR build SHALL execute and produce the runtime bundle in `dist/`
- **AND** the workflow build SHALL execute and produce workflow bundles in `workflows/dist/`

## ADDED Requirements

### Requirement: Start script builds workflows and starts runtime
The root `package.json` SHALL include a `start` script that builds workflows and then starts the runtime with `WORKFLOW_DIR` set to the workflows build output.

#### Scenario: pnpm start runs end-to-end
- **WHEN** `pnpm start` is run from the repository root
- **THEN** workflows SHALL be built first
- **AND** the runtime SHALL start with `WORKFLOW_DIR` pointing to the built workflow files
