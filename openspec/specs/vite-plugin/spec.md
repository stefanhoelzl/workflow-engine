### Requirement: Plugin accepts explicit workflow list

The vite plugin SHALL be importable from `@workflow-engine/sdk/plugin` (previously `@workflow-engine/vite-plugin`). Configuration accepts a `workflows` field listing workflow source file paths. Does not scan directories. Each path corresponds to exactly one workflow.

#### Scenario: Importing plugin from new path

- **WHEN** a vite config imports `{ workflowPlugin } from "@workflow-engine/sdk/plugin"`
- **THEN** it receives the same plugin factory as the previous `@workflow-engine/vite-plugin` package

#### Scenario: Explicit workflow list

- **WHEN** the plugin is configured with `workflows: ["./cronitor.ts"]`
- **THEN** it SHALL process only `cronitor.ts`
- **AND** it SHALL NOT discover or process other `.ts` files in the directory

### Requirement: Vite plugin package

The vite plugin code SHALL live inside the `@workflow-engine/sdk` package at `src/plugin/`. It is no longer a standalone package. The standalone `@workflow-engine/vite-plugin` package SHALL be deleted.

#### Scenario: Standalone package removed

- **WHEN** inspecting the packages directory
- **THEN** `packages/vite-plugin/` does not exist

#### Scenario: Plugin source lives in SDK

- **WHEN** inspecting the SDK package
- **THEN** `packages/sdk/src/plugin/index.ts` exports the `workflowPlugin` function

### Requirement: Per-workflow bundle

The plugin SHALL emit one bundled JavaScript file per workflow source file (not per action). The bundle SHALL contain all action handlers, the trigger handler, and module-scoped constants/imports. The bundle SHALL be written to `<outDir>/<workflow-name>/<workflow-name>.js` (e.g., `dist/cronitor/cronitor.js`).

The bundle SHALL use Rollup output `format: "iife"`. The IIFE namespace name SHALL be a fixed constant (`IIFE_NAMESPACE`) exported from `@workflow-engine/core` and imported by both the plugin (as Rollup's `output.name`) and the sandbox (when reading exports). The namespace SHALL NOT be derived from the workflow name. Exports SHALL be accessible from the IIFE's namespace object on `globalThis[IIFE_NAMESPACE]`.

The bundle SHALL NOT include the `@workflow-engine/sandbox-globals` polyfill import. Web API globals (`URL`, `TextEncoder`, `Headers`, `crypto`, `atob`, `btoa`, `structuredClone`, `fetch`, `Blob`, `AbortController`, `ReadableStream`) SHALL be provided by the sandbox's WASM extensions and host bridges, not by polyfills bundled into the workflow code.

#### Scenario: One IIFE bundle per workflow

- **GIVEN** a workflow file `cronitor.ts` declaring two actions and one trigger
- **WHEN** the plugin builds
- **THEN** the plugin SHALL emit exactly one workflow bundle: `dist/cronitor/cronitor.js`
- **AND** the bundle SHALL be an IIFE that assigns exports to `globalThis[IIFE_NAMESPACE]`

#### Scenario: Namespace is the shared constant, not derived from workflow name

- **GIVEN** two workflow files `cronitor.ts` and `demo.ts`
- **WHEN** the plugin builds each
- **THEN** both bundles SHALL assign their exports to the same namespace identifier (the value of `IIFE_NAMESPACE` from `@workflow-engine/core`)
- **AND** neither bundle SHALL use a workflow-name-derived namespace such as `__wf_cronitor` or `__wf_demo`

#### Scenario: Bundle does not contain polyfills

- **GIVEN** a workflow file that previously relied on `@workflow-engine/sandbox-globals`
- **WHEN** the plugin builds
- **THEN** the bundle SHALL NOT contain `whatwg-fetch`, `blob-polyfill`, `mock-xmlhttprequest`, or any sandbox-globals polyfill code
- **AND** the bundle SHALL NOT contain an `import` statement for `@workflow-engine/sandbox-globals`

#### Scenario: Bundle contains module-scoped imports and constants

- **GIVEN** a workflow file with `import { format } from "date-fns"` and `const BASE = "..."` at module scope
- **WHEN** the plugin builds
- **THEN** the bundle SHALL inline the `format` import and preserve `BASE` as a scoped constant
- **AND** the SDK and Zod runtime code SHALL NOT be included in the bundle

### Requirement: Brand-symbol export discovery

The plugin SHALL discover the workflow's `Workflow` config, `Action`s, and `HttpTrigger`s (and other future trigger types) by walking the workflow file's exports and matching brand symbols on each export value. The plugin SHALL NOT use reference equality on handler functions for identification.

The plugin SHALL recognize:
- `Symbol.for("@workflow-engine/workflow")` -> workflow config (at most one per file)
- `Symbol.for("@workflow-engine/action")` -> action; identity = export name
- `Symbol.for("@workflow-engine/http-trigger")` -> HTTP trigger; identity = export name

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

When the workflow's `defineWorkflow({name})` argument is omitted (or `defineWorkflow` itself is omitted), the plugin SHALL derive the workflow name from the workflow file's filestem (e.g., `cronitor.ts` -> `"cronitor"`). When `name` is provided, the plugin SHALL use it as-is.

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
