## MODIFIED Requirements

### Requirement: Two-pass build per workflow

The plugin SHALL perform two passes for each workflow file: a manifest extraction pass and an actions bundling pass.

#### Scenario: Manifest pass extracts metadata

- **WHEN** the plugin processes a workflow file
- **THEN** it SHALL import the module, call `.compile()` on the default export, and write the manifest data to `manifest.json`

#### Scenario: Actions pass produces one file per action with default export

- **WHEN** the plugin processes a workflow file with actions `handleCronitorEvent` and `sendMessage`
- **THEN** it SHALL produce `dist/cronitor/handleCronitorEvent.js` and `dist/cronitor/sendMessage.js`
- **AND** each file SHALL contain `export default async (ctx) => { ... }` with the handler body
- **AND** the files SHALL NOT import from `@workflow-engine/sdk` or `zod`

### Requirement: Per-workflow output directories

The plugin SHALL output each workflow's artifacts into a subdirectory of the output directory, named after the source filename (without extension).

#### Scenario: Output directory structure

- **WHEN** the plugin processes `cronitor.ts` with actions `handleCronitorEvent` and `sendMessage`
- **THEN** it SHALL produce `dist/cronitor/manifest.json`, `dist/cronitor/handleCronitorEvent.js`, and `dist/cronitor/sendMessage.js`

### Requirement: Transform hook produces default exports

The plugin SHALL transform each action's handler into a standalone file with a default export. The transform SHALL extract the handler function body from the `.action({...handler: fn...})` wrapper and emit it as `export default async (ctx) => { ... }`.

#### Scenario: Handler extracted as default export

- **WHEN** the source contains `export const foo = workflow.action({ on: "e", handler: async (ctx) => { await ctx.emit("x", {}); } })`
- **THEN** the transform SHALL produce a file `foo.js` containing `export default async (ctx) => { await ctx.emit("x", {}); }`

#### Scenario: Module-level imports preserved

- **WHEN** a handler references a module-level import (e.g., `import { format } from "./utils"`)
- **THEN** the import SHALL be preserved in the action's output file
- **AND** the handler's reference to `format` SHALL remain valid

#### Scenario: Module-level constants preserved

- **WHEN** a handler references a module-level constant (e.g., `const BASE_URL = "..."`)
- **THEN** the constant SHALL be preserved in the action's output file
