## MODIFIED Requirements

### Requirement: Two-pass build per workflow

The plugin SHALL perform two passes for each workflow file: a metadata extraction pass using `tsImport()` from `tsx/esm/api` on the original `.ts` source, and a stub-SDK Vite build pass that produces a single ES module per workflow containing all action handlers as named exports.

#### Scenario: Metadata pass extracts manifest via tsx import

- **WHEN** the plugin processes a workflow file with `createWorkflow("cronitor")`
- **THEN** it SHALL import the `.ts` source via `tsImport()`, call `.compile()` on the default export, and produce manifest data including `name: "cronitor"`
- **AND** it SHALL NOT write a temporary file for metadata extraction

#### Scenario: Build pass produces single module with named exports

- **WHEN** the plugin processes a workflow file with actions `handleCronitorEvent` and `sendMessage`
- **THEN** it SHALL produce `dist/cronitor/actions.js` containing both handlers as named exports
- **AND** the module SHALL NOT contain `@workflow-engine/sdk` or `zod` code
- **AND** the module size SHALL be proportional to the handler code, not the SDK/Zod dependency tree

### Requirement: Transform hook produces default exports

The plugin SHALL transform each workflow into a standalone ES module by running a secondary `vite.build()` with a stub SDK plugin. The stub SHALL replace `@workflow-engine/sdk` so that `workflow.action({ handler })` returns `handler` directly. The secondary build SHALL use `build.ssr: true`, `ssr.noExternal: true`, `enforce: 'pre'` on the stub plugin, and `rollupOptions.input` pointing to the original workflow `.ts` file.

#### Scenario: Handler preserved as named export with npm imports bundled

- **WHEN** a handler imports `format` from `date-fns` and calls it
- **THEN** the output module SHALL contain the `format` function bundled inline
- **AND** the handler's named export SHALL be callable with the same behavior

#### Scenario: Module-level imports preserved

- **WHEN** a handler references a module-level import (e.g., `import { format } from "date-fns"`)
- **THEN** the import SHALL be resolved and bundled into the output module
- **AND** the handler's reference to `format` SHALL remain valid

#### Scenario: Module-level constants preserved

- **WHEN** a handler references a module-level constant (e.g., `const BASE_URL = "..."`)
- **THEN** the constant SHALL be preserved in the output module

### Requirement: Per-workflow output directories

The plugin SHALL output each workflow's artifacts into a subdirectory of the output directory, named after the workflow name from `createWorkflow("name")`. The module file SHALL be named `actions.js` at the workflow subdirectory root.

#### Scenario: Output directory structure

- **WHEN** the plugin processes a workflow created with `createWorkflow("cronitor")` with actions `handleCronitorEvent` and `sendMessage`
- **THEN** it SHALL produce `dist/cronitor/manifest.json` and `dist/cronitor/actions.js`
- **AND** `actions.js` SHALL export both `handleCronitorEvent` and `sendMessage` as named exports

## REMOVED Requirements

### Requirement: Action name resolution via export matching

**Reason**: Export matching by reference equality is still used during metadata extraction, but has moved to the manifest extraction phase (not a separate requirement). The matching logic is unchanged — it is part of the "Two-pass build per workflow" requirement.
**Migration**: No code migration needed. The matching logic remains identical; it is just no longer a standalone spec requirement.

