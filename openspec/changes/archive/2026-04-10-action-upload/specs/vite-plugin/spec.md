## MODIFIED Requirements

### Requirement: Per-workflow output directories

The plugin SHALL output each workflow's artifacts into a subdirectory of the output directory, named after the workflow name from `createWorkflow("name")`. Action files SHALL be placed in an `actions/` subdirectory.

#### Scenario: Output directory structure

- **WHEN** the plugin processes a workflow created with `createWorkflow("cronitor")` with actions `handleCronitorEvent` and `sendMessage`
- **THEN** it SHALL produce `dist/cronitor/manifest.json`, `dist/cronitor/actions/handleCronitorEvent.js`, and `dist/cronitor/actions/sendMessage.js`

### Requirement: Two-pass build per workflow

The plugin SHALL perform two passes for each workflow file: a manifest extraction pass and an actions bundling pass.

#### Scenario: Manifest pass extracts metadata including name

- **WHEN** the plugin processes a workflow file with `createWorkflow("cronitor")`
- **THEN** it SHALL import the module, call `.compile()` on the default export, and write the manifest data (including `name: "cronitor"`) to `manifest.json`

#### Scenario: Actions pass produces one file per action under actions/ directory with default export

- **WHEN** the plugin processes a workflow file with actions `handleCronitorEvent` and `sendMessage`
- **THEN** it SHALL produce `dist/cronitor/actions/handleCronitorEvent.js` and `dist/cronitor/actions/sendMessage.js`
- **AND** each file SHALL contain `export default async (ctx) => { ... }` with the handler body
- **AND** the files SHALL NOT import from `@workflow-engine/sdk` or `zod`
