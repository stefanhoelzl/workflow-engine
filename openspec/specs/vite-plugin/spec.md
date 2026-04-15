# Vite Plugin Specification

## Purpose

Compile each workflow source file into a sandbox-safe bundle (`manifest.json` + `actions.js` + `bundle.tar.gz`) consumable by the runtime's `POST /api/workflows` endpoint. The plugin owns the metadata-extraction pass (`tsImport` + `.compile()`), the action-module build pass (nested vite build with polyfilled globals), tar.gz packing, and TypeScript type-checking. Workflow entries are auto-discovered from `<root>/src/*.ts`; the plugin is consumed exclusively by `@workflow-engine/cli`'s shipped default config.

## Requirements

### Requirement: Auto-discovery of workflow entry files

The `@workflow-engine/vite-plugin` SHALL auto-discover workflow entry files by globbing `<vite-root>/src/*.ts` non-recursively when the plugin is invoked with no options: `workflowPlugin()`. Each matched file becomes a workflow whose name is the file basename without the `.ts` extension.

The plugin SHALL NOT accept a `workflows: string[]` option. Callers MUST rely on auto-discovery.

#### Scenario: No options given, single workflow present

- **WHEN** `workflowPlugin()` is invoked and `<vite-root>/src/foo.ts` exists
- **THEN** the plugin SHALL treat `foo` as the sole workflow entry
- **AND** the build SHALL emit `dist/foo/bundle.tar.gz`

#### Scenario: No options given, multiple workflows present

- **WHEN** `workflowPlugin()` is invoked and `<vite-root>/src/` contains `foo.ts` and `bar.ts`
- **THEN** the plugin SHALL treat both as workflow entries
- **AND** the build SHALL emit `dist/foo/bundle.tar.gz` and `dist/bar/bundle.tar.gz`

#### Scenario: Files in nested directories are ignored

- **WHEN** `<vite-root>/src/` contains `foo.ts` and a subdirectory `shared/util.ts`
- **THEN** the plugin SHALL treat only `foo` as a workflow entry
- **AND** `util` SHALL NOT be treated as a workflow entry

### Requirement: Loud failure when src/ is empty or missing

The plugin SHALL fail the build loudly when the auto-discovery step finds no workflow entry files. The failure SHALL be reported via vite's plugin error mechanism with a message that names the expected directory.

#### Scenario: Missing src directory

- **WHEN** the plugin runs and `<vite-root>/src/` does not exist
- **THEN** the build SHALL fail with an error message that includes the text `no workflows found`
- **AND** the error message SHALL include the absolute path the plugin was looking at

#### Scenario: Empty src directory

- **WHEN** the plugin runs and `<vite-root>/src/` exists but has no `.ts` files at the top level
- **THEN** the build SHALL fail with an error message that includes the text `no workflows found`

### Requirement: Bundle artifact produced per workflow

For each discovered workflow `<name>`, the plugin SHALL emit a `<name>/bundle.tar.gz` artifact under the vite build output directory. The tar archive SHALL contain `manifest.json` and `actions.js` at its root. This `bundle.tar.gz` is the sole artifact consumed by downstream upload tooling (`@workflow-engine/cli`).

#### Scenario: Bundle contains manifest and action module

- **WHEN** the plugin successfully builds workflow `foo`
- **THEN** `dist/foo/bundle.tar.gz` SHALL unpack into files named `manifest.json` and `actions.js`

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

The plugin SHALL transform each workflow into a standalone ES module by running a secondary `vite.build()` with a stub SDK plugin and a sandbox-globals plugin. The stub SHALL replace `@workflow-engine/sdk` so that `workflow.action({ handler })` returns `handler` directly. The sandbox-globals plugin SHALL resolve `@workflow-engine/sandbox-globals` to a virtual module that sets up Web API polyfills on `globalThis`, and SHALL inject `import "@workflow-engine/sandbox-globals"` at the top of the workflow entry via a `transform` hook. The secondary build SHALL use `build.ssr: true`, `ssr.noExternal: true`, `enforce: 'pre'` on both plugins, and `rollupOptions.input` pointing to the original workflow `.ts` file.

#### Scenario: Handler preserved as named export with npm imports and polyfills bundled

- **WHEN** a handler imports `format` from `date-fns` and calls it
- **THEN** the output module SHALL contain the `format` function bundled inline
- **AND** the handler's named export SHALL be callable with the same behavior
- **AND** the output module SHALL contain polyfill setup code for globals used by `date-fns`

#### Scenario: Module-level imports preserved

- **WHEN** a handler references a module-level import (e.g., `import { format } from "date-fns"`)
- **THEN** the import SHALL be resolved and bundled into the output module
- **AND** the handler's reference to `format` SHALL remain valid

#### Scenario: Module-level constants preserved

- **WHEN** a handler references a module-level constant (e.g., `const BASE_URL = "..."`)
- **THEN** the constant SHALL be preserved in the output module

#### Scenario: Polyfill virtual module is resolved

- **WHEN** the secondary build encounters `import "@workflow-engine/sandbox-globals"`
- **THEN** the sandbox-globals plugin SHALL resolve it to the virtual module ID `"\0sandbox-globals"`
- **AND** the virtual module source SHALL be loaded and bundled into the output

#### Scenario: Polyfill import is injected into workflow entry

- **WHEN** the secondary build transforms the workflow `.ts` file
- **THEN** `import "@workflow-engine/sandbox-globals"` SHALL be prepended to the source
- **AND** the polyfill setup code SHALL execute before any action handler code

### Requirement: Per-workflow output directories

The plugin SHALL output each workflow's artifacts into a subdirectory of the output directory, named after the workflow name from `createWorkflow("name")`. The module file SHALL be named `actions.js` at the workflow subdirectory root.

#### Scenario: Output directory structure

- **WHEN** the plugin processes a workflow created with `createWorkflow("cronitor")` with actions `handleCronitorEvent` and `sendMessage`
- **THEN** it SHALL produce `dist/cronitor/manifest.json` and `dist/cronitor/actions.js`
- **AND** `actions.js` SHALL export both `handleCronitorEvent` and `sendMessage` as named exports

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
