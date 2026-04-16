## ADDED Requirements

### Requirement: Plugin accepts explicit workflow list

The Vite plugin SHALL accept a configuration object with a `workflows` field listing the workflow source file paths. The plugin SHALL NOT scan directories for workflow files. Each path SHALL correspond to exactly one workflow (one workflow per file).

#### Scenario: Explicit workflow list

- **WHEN** the plugin is configured with `workflows: ["./cronitor.ts"]`
- **THEN** it SHALL process only `cronitor.ts`
- **AND** it SHALL NOT discover or process other `.ts` files in the directory

### Requirement: Per-workflow bundle

The plugin SHALL emit one bundled JavaScript module per workflow source file (not per action). The bundle SHALL contain all action handlers, the trigger handler, and module-scoped constants/imports as named exports. The bundle SHALL be written to `<outDir>/<workflow-name>/<workflow-name>.js` (e.g., `dist/cronitor/cronitor.js`).

#### Scenario: One bundle per workflow

- **GIVEN** a workflow file `cronitor.ts` declaring two actions and one trigger
- **WHEN** the plugin builds
- **THEN** the plugin SHALL emit exactly one workflow bundle: `dist/cronitor/cronitor.js`
- **AND** the bundle SHALL export the actions and trigger by their original export names

#### Scenario: Bundle contains module-scoped imports and constants

- **GIVEN** a workflow file with `import { format } from "date-fns"` and `const BASE = "..."` at module scope
- **WHEN** the plugin builds
- **THEN** the bundle SHALL inline the `format` import and preserve `BASE` as a module-scoped constant
- **AND** the SDK and Zod runtime code SHALL NOT be included in the bundle

### Requirement: Brand-symbol export discovery

The plugin SHALL discover the workflow's `Workflow` config, `Action`s, and `HttpTrigger`s (and other future trigger types) by walking the workflow file's exports and matching brand symbols on each export value. The plugin SHALL NOT use reference equality on handler functions for identification.

The plugin SHALL recognize:
- `Symbol.for("@workflow-engine/workflow")` → workflow config (at most one per file)
- `Symbol.for("@workflow-engine/action")` → action; identity = export name
- `Symbol.for("@workflow-engine/http-trigger")` → HTTP trigger; identity = export name

#### Scenario: Plugin identifies action by brand

- **GIVEN** `export const sendNotification = action({...})` in a workflow file
- **WHEN** the plugin walks exports
- **THEN** the plugin SHALL detect `sendNotification` as an action via the `ACTION_BRAND` symbol
- **AND** SHALL register it with `name: "sendNotification"`

#### Scenario: Plugin identifies HTTP trigger by brand

- **GIVEN** `export const myTrigger = httpTrigger({...})` in a workflow file
- **WHEN** the plugin walks exports
- **THEN** the plugin SHALL detect `myTrigger` as an HTTP trigger via the `HTTP_TRIGGER_BRAND` symbol
- **AND** SHALL register it with `name: "myTrigger"`

#### Scenario: Plugin ignores unbranded exports

- **GIVEN** a workflow file with `export function helper() { ... }` and other non-action/trigger exports
- **WHEN** the plugin walks exports
- **THEN** non-branded exports SHALL be ignored for the manifest
- **AND** they SHALL still be bundled (they may be referenced by handlers)

### Requirement: Workflow name derivation

When the workflow's `defineWorkflow({name})` argument is omitted (or `defineWorkflow` itself is omitted), the plugin SHALL derive the workflow name from the workflow file's filestem (e.g., `cronitor.ts` → `"cronitor"`). When `name` is provided, the plugin SHALL use it as-is.

#### Scenario: Name from filestem

- **GIVEN** a workflow file `workflows/cronitor.ts` with `defineWorkflow()` (no name)
- **WHEN** the plugin builds
- **THEN** the manifest SHALL have `name: "cronitor"`
- **AND** the bundle SHALL be at `dist/cronitor/cronitor.js`

#### Scenario: Explicit name overrides filestem

- **GIVEN** `defineWorkflow({ name: "my-workflow" })` in `cronitor.ts`
- **WHEN** the plugin builds
- **THEN** the manifest SHALL have `name: "my-workflow"`

### Requirement: Action call resolution at build time

The plugin SHALL resolve `await someAction(input)` calls inside handlers by injecting the action's name. Specifically: the SDK's `action({...})` returns a callable shim whose body is `(input) => __hostCallAction(<name>, input)`; the plugin SHALL fill in `<name>` as the action's export name during the build pass.

#### Scenario: Action call compiles to host bridge invocation

- **GIVEN** `await sendNotification({ message: "x" })` inside a trigger handler
- **WHEN** the bundle is built
- **THEN** the compiled bundle SHALL invoke `__hostCallAction("sendNotification", { message: "x" })` at the call site

### Requirement: Build failure on validation errors

The plugin SHALL fail the Vite build if a workflow file declares zero or more than one `defineWorkflow(...)` exports, if any action's `input` or `output` is not a Zod schema, or if TypeScript type checking detects errors in workflow files during production builds.

#### Scenario: Multiple defineWorkflow exports fails

- **GIVEN** a workflow file with two `defineWorkflow(...)` exports
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error indicating "at most one defineWorkflow per file"

#### Scenario: Action without input schema fails

- **GIVEN** an action whose `input` is not a Zod schema
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error identifying the action

## REMOVED Requirements

### Requirement: Two-pass build per workflow

**Reason**: The two-pass mechanism (metadata extraction via `tsx` followed by stub-SDK Vite build) was needed because the SDK's `createWorkflow().compile()` returned manifest data via runtime introspection. With brand-symbol-based discovery, the plugin walks exports of the bundled module directly; no separate metadata pass via `tsImport` is needed.

**Migration**: Plugin restructures into a single-pass build that walks exports of the bundled workflow module to assemble the manifest.

### Requirement: Transform hook produces default exports

**Reason**: The previous transform hook produced per-action default-export modules. v1 emits one named-export module per workflow, retaining the original export names for actions and triggers.

**Migration**: Plugin emits per-workflow named-export bundles.

### Requirement: Per-workflow output directories

**Reason**: Output structure is updated: `dist/<name>/<name>.js` replaces `dist/<name>/actions.js`. The directory structure is preserved (one subdirectory per workflow with `manifest.json` alongside the bundle).

**Migration**: Update consumers expecting `actions.js` to look for `<workflow-name>.js`.
