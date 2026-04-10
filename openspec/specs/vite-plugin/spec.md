### Requirement: Plugin accepts explicit workflow list

The Vite plugin SHALL accept a configuration object with a `workflows` field listing the workflow source file paths. The plugin SHALL NOT scan directories for workflow files.

#### Scenario: Explicit workflow list
- **WHEN** the plugin is configured with `workflows: ["./cronitor.ts"]`
- **THEN** it SHALL process only `cronitor.ts`
- **AND** it SHALL NOT discover or process other `.ts` files in the directory

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

### Requirement: Action name resolution via export matching

The plugin SHALL resolve action names by matching handler function references from `.compile()` output to the module's named exports via reference equality.

#### Scenario: Action name from export variable
- **WHEN** a workflow exports `const handleEvent = workflow.action({handler: async (ctx) => {...}})`
- **THEN** the action name in `manifest.json` SHALL be `"handleEvent"`
- **AND** the `handler` field SHALL be `"handleEvent"`

#### Scenario: Explicit name override
- **WHEN** a workflow exports `const handle = workflow.action({name: "handleCronitorEvent", handler: async (ctx) => {...}})`
- **THEN** the action name in `manifest.json` SHALL be `"handleCronitorEvent"`
- **AND** the `handler` field SHALL be `"handle"`

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

### Requirement: Per-workflow output directories

The plugin SHALL output each workflow's artifacts into a subdirectory of the output directory, named after the source filename (without extension).

#### Scenario: Output directory structure

- **WHEN** the plugin processes `cronitor.ts` with actions `handleCronitorEvent` and `sendMessage`
- **THEN** it SHALL produce `dist/cronitor/manifest.json`, `dist/cronitor/handleCronitorEvent.js`, and `dist/cronitor/sendMessage.js`

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
