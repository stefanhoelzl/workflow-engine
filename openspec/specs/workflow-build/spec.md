## Purpose

Define the build-time contract between a workflow author's TypeScript source (under `workflows/`) and the tenant bundle the runtime consumes. The plugin emits a **single tenant tarball** at `<outDir>/bundle.tar.gz` containing a root `manifest.json` (listing every discovered workflow) plus one `<name>.js` file per workflow at the tarball root. Owns the `@workflow-engine/sdk/plugin` Vite plugin that performs brand-symbol export discovery, action-name AST injection, per-kind manifest emission, trigger-identifier URL-safety validation, and build-time TypeScript typecheck against a fixed strict compiler configuration.
## Requirements
### Requirement: Workflow source files in workflows directory
Each workflow SHALL be a single TypeScript file in the `workflows/` directory that exports branded SDK products (`defineWorkflow`, `action`, `httpTrigger`). Action and trigger identity SHALL be determined by export names.

#### Scenario: Workflow file structure
- **WHEN** a developer creates `workflows/cronitor.ts`
- **THEN** it SHALL export branded SDK products as named constants
- **AND** it SHALL import `defineWorkflow`, `action`, `httpTrigger`, and `z` from `@workflow-engine/sdk`

### Requirement: Workflows directory is a pnpm workspace member
The `workflows/` directory SHALL have a `package.json` declaring only `@workflow-engine/sdk` as a workspace dependency and SHALL be listed in `pnpm-workspace.yaml`. The separate `@workflow-engine/cli` dependency is no longer needed.

#### Scenario: workflows/package.json dependencies
- **WHEN** inspecting `workflows/package.json`
- **THEN** it lists `@workflow-engine/sdk` as a dependency
- **THEN** it does NOT list `@workflow-engine/cli` or `@workflow-engine/vite-plugin`

#### Scenario: Plugin dependency resolution
- **WHEN** `pnpm install` is run at the repository root
- **THEN** `@workflow-engine/sdk` SHALL be resolved as a workspace link for the workflows directory

### Requirement: Root build includes workflows

The root `pnpm build` script SHALL build the runtime and SHALL produce per-workflow JS files but SHALL NOT produce `workflows/dist/bundle.tar.gz` or `workflows/dist/manifest.json`. Producing a deployable tenant tarball requires sealing, which is only available via `wfe upload` (which calls the internal `bundle` function) because sealing needs the server public key.

#### Scenario: Full build

- **WHEN** `pnpm build` is run from the repository root
- **THEN** `dist/main.js` (runtime) SHALL be produced
- **AND** each declared workflow SHALL have a corresponding `workflows/dist/<name>.js` file produced
- **AND** `workflows/dist/bundle.tar.gz` SHALL NOT be produced
- **AND** `workflows/dist/manifest.json` SHALL NOT be produced

#### Scenario: Deployable tarball requires upload path

- **WHEN** a deployable tenant tarball is needed
- **THEN** it SHALL be produced by `wfe upload` (or the internal `bundle` function it calls)
- **AND** it SHALL NOT be produced as a side effect of `pnpm build`
- **AND** it SHALL NOT be written to disk at any point in the upload pipeline

### Requirement: Per-workflow bundle output

The build SHALL produce one bundled JS module per workflow file, named `<name>.js` and packed at the root of the tenant tarball. Each bundle SHALL contain all action handlers, the trigger handler(s), and module-scoped imports/constants as named exports under their original names.

#### Scenario: Single bundle per workflow inside the tenant tarball

- **GIVEN** a workflow file `cronitor.ts` with two actions and one trigger
- **WHEN** the build runs
- **THEN** the tenant tarball SHALL contain exactly one entry `cronitor.js` at its root
- **AND** the bundle SHALL export each action and the trigger by their original export names

#### Scenario: Bundle includes module-scoped npm imports

- **GIVEN** a handler importing `format` from `date-fns`
- **WHEN** the build runs
- **THEN** the bundle SHALL inline the `format` function

### Requirement: Build emits root manifest alongside workflow bundles in the tarball

The build SHALL emit a single tenant tarball `<outDir>/bundle.tar.gz` whose entries are `manifest.json` at the root plus one `<name>.js` per workflow at the root. The root manifest's shape is `{ workflows: [...] }` where each element follows the per-workflow manifest format defined by the `workflow-manifest` capability spec.

#### Scenario: Tarball contains root manifest and per-workflow bundles

- **GIVEN** workflows named `cronitor` and `demo`
- **WHEN** the build runs
- **THEN** `workflows/dist/bundle.tar.gz` SHALL exist
- **AND** extracting it SHALL yield `manifest.json`, `cronitor.js`, and `demo.js` at the tarball root
- **AND** the `manifest.json` SHALL have shape `{ workflows: [<cronitor-manifest>, <demo-manifest>] }`

### Requirement: Plugin accepts explicit workflow list

The Vite plugin SHALL be importable from `@workflow-engine/sdk/plugin`. The plugin's configuration accepts a `workflows` field listing workflow source file paths. The plugin SHALL NOT scan directories; each path corresponds to exactly one workflow.

#### Scenario: Importing plugin from sdk subpath

- **WHEN** a vite config imports `{ workflowPlugin } from "@workflow-engine/sdk/plugin"`
- **THEN** it receives the plugin factory

#### Scenario: Explicit workflow list

- **WHEN** the plugin is configured with `workflows: ["./cronitor.ts"]`
- **THEN** it SHALL process only `cronitor.ts`
- **AND** it SHALL NOT discover or process other `.ts` files in the directory

### Requirement: Vite plugin lives inside the SDK package

The vite plugin code SHALL live inside `@workflow-engine/sdk` at `packages/sdk/src/plugin/`. It is NOT a standalone package; the former `@workflow-engine/vite-plugin` package does not exist.

#### Scenario: Plugin source inside SDK

- **WHEN** inspecting the SDK package
- **THEN** `packages/sdk/src/plugin/index.ts` exports the `workflowPlugin` function

#### Scenario: No standalone vite-plugin package

- **WHEN** inspecting `packages/`
- **THEN** there is no `packages/vite-plugin/` directory

### Requirement: Per-workflow IIFE bundle with shared namespace

The plugin SHALL emit one bundled JavaScript file per workflow source file. The bundle SHALL contain every action handler, every trigger handler, and module-scoped constants + imports. The bundle SHALL be packed into the tenant tarball at the root as `<workflow-name>.js`. Rollup output `format` SHALL be `"iife"`; the IIFE namespace name SHALL be the fixed `IIFE_NAMESPACE` constant exported from `@workflow-engine/core` and imported both by the plugin (as Rollup's `output.name`) and by the sandbox (when reading exports). The namespace SHALL NOT be derived from the workflow name. Exports SHALL be accessible via `globalThis[IIFE_NAMESPACE]`.

The bundle SHALL NOT import `@workflow-engine/sdk` or `zod`. Web-platform globals (`URL`, `TextEncoder`, `Headers`, `crypto`, `atob`, `btoa`, `structuredClone`, `fetch`, `Blob`, `AbortController`, `ReadableStream`) SHALL NOT be polyfilled in the bundle; they are provided by the sandbox's Phase-1 quickjs-wasi extensions and by `sandbox-stdlib`'s plugins at Phase 2.

#### Scenario: One IIFE bundle per workflow

- **GIVEN** a workflow file `cronitor.ts` declaring two actions and one trigger
- **WHEN** the plugin builds
- **THEN** exactly one tarball entry `cronitor.js` SHALL be emitted at the tenant-tarball root
- **AND** the bundle SHALL assign its exports to `globalThis[IIFE_NAMESPACE]`

#### Scenario: Namespace is the shared constant

- **GIVEN** two workflow files `cronitor.ts` and `demo.ts`
- **WHEN** the plugin builds each
- **THEN** both bundles SHALL use the same namespace identifier (value of `IIFE_NAMESPACE`)
- **AND** neither SHALL use a workflow-name-derived namespace such as `__wf_cronitor`

#### Scenario: Bundle excludes SDK and Zod

- **WHEN** any workflow is built
- **THEN** the bundle SHALL NOT contain `import` statements referencing `@workflow-engine/sdk` or `zod`

#### Scenario: Bundle excludes web-platform polyfills

- **WHEN** any workflow is built
- **THEN** the bundle SHALL NOT contain `whatwg-fetch`, `blob-polyfill`, or other web-platform polyfill code

### Requirement: Brand-symbol export discovery

The plugin SHALL discover the workflow's `Workflow` config, `Action`s, `HttpTrigger`s, `CronTrigger`s, and `ManualTrigger`s by walking the workflow file's exports and matching brand symbols on each export value. The plugin SHALL NOT use reference equality on handler functions for identification.

Recognized brand symbols (from `@workflow-engine/core`):
- `Symbol.for("@workflow-engine/workflow")` → workflow config (at most one per file)
- `Symbol.for("@workflow-engine/action")` → action; identity = export name
- `Symbol.for("@workflow-engine/http-trigger")` → HTTP trigger; identity = export name
- `Symbol.for("@workflow-engine/cron-trigger")` → cron trigger; identity = export name
- `Symbol.for("@workflow-engine/manual-trigger")` → manual trigger; identity = export name

The plugin SHALL maintain a `Map<Action, exportName>` while walking exports. If the same action callable is observed under two export names, the plugin SHALL fail the build with `ERR_ACTION_MULTI_NAME`.

#### Scenario: Action identified by brand and export name

- **GIVEN** `export const sendNotification = action({...})` in a workflow file
- **WHEN** the plugin walks exports
- **THEN** it SHALL detect `sendNotification` as an action via the action brand symbol
- **AND** register it with `name: "sendNotification"` in the manifest

#### Scenario: Each trigger kind detected by its own brand

- **GIVEN** `export const hook = httpTrigger({...})`, `export const nightly = cronTrigger({...})`, `export const rerun = manualTrigger({...})`
- **WHEN** the plugin walks exports
- **THEN** each SHALL be registered under its respective kind (`http` / `cron` / `manual`)

#### Scenario: Unbranded exports ignored for manifest but kept in bundle

- **GIVEN** a workflow with `export function helper() { ... }`
- **WHEN** the plugin walks exports
- **THEN** `helper` SHALL NOT appear in the manifest
- **AND** the bundle SHALL retain `helper` because handlers may reference it

#### Scenario: Aliased action fails the build

- **GIVEN** `export const X = action({...}); export { X as Y };`
- **WHEN** the plugin walks the evaluated exports
- **THEN** the identity-set check SHALL detect the same callable under two names
- **AND** the build SHALL fail with `ERR_ACTION_MULTI_NAME`

### Requirement: Workflow name derivation

When `defineWorkflow({name})` is omitted (or `defineWorkflow` itself is omitted), the plugin SHALL derive the workflow name from the source file's filestem (e.g., `cronitor.ts` → `"cronitor"`). When `name` is provided explicitly, the plugin SHALL use it as-is.

#### Scenario: Name from filestem

- **GIVEN** `workflows/cronitor.ts` with `defineWorkflow()` (no name)
- **WHEN** the plugin builds
- **THEN** the manifest SHALL have `name: "cronitor"`
- **AND** the bundle SHALL appear as `cronitor.js` at the root of the tenant tarball

#### Scenario: Explicit name overrides filestem

- **GIVEN** `defineWorkflow({ name: "my-workflow" })` in `cronitor.ts`
- **WHEN** the plugin builds
- **THEN** the manifest SHALL have `name: "my-workflow"`

### Requirement: Action-name AST injection at build time

The plugin SHALL inject each action's identity into its `action({...})` call expression by AST-transforming workflow source files during Rollup's `transform` hook. The transform SHALL:

1. Parse the source via the `acorn` parser available via Vite / Rollup.
2. Walk top-level statements, locating `ExportNamedDeclaration` nodes whose descendant is `const <ID> = action({...})` with an `ObjectExpression` first argument.
3. Inject `name: "<ID>"` into that object literal via `MagicString`, preserving sourcemaps.

The transform SHALL recognize ONLY the canonical declaration form `export const X = action({...})`. Other forms (detached exports, default exports, conditional definitions, factory wrappers) SHALL NOT be transformed; they are caught by the post-bundle validation step (see the "Untransformed action exports fail the build" scenario).

After the bundle is built and the plugin walks the evaluated exports for manifest derivation, the plugin SHALL verify that every `Action`-branded export carries a non-empty `.name`. If any action lacks a name, the build SHALL fail with `"Workflow \"<file>\": action \"<exportName>\" was not transformed at build time. Actions must be declared as: export const X = action({...})"`.

The plugin SHALL NOT call `__setActionName` on action callables (the slot no longer exists). The runtime SHALL NOT append a name-binder shim to the bundle (see `workflow-registry` Sandbox loading requirements).

#### Scenario: Plugin injects name into action call expression

- **GIVEN** `export const sendNotification = action({ input: z.object({}), output: z.string(), handler: async () => "ok" })` in `cronitor.ts`
- **WHEN** the plugin transforms the source
- **THEN** the transformed source SHALL contain `name: "sendNotification"` inside the object literal
- **AND** the post-bundle manifest SHALL contain an action entry with `name: "sendNotification"`

#### Scenario: Untransformed action exports fail the build

- **GIVEN** `const inner = action({...}); export { inner };` (detached export)
- **WHEN** the plugin builds
- **THEN** the AST transform SHALL leave the call unchanged
- **AND** the post-bundle validation step SHALL fail with the "was not transformed at build time" message

#### Scenario: Default-exported action fails the build

- **GIVEN** `export default action({...})`
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with `"action cannot be a default export; use export const"`

### Requirement: HTTP trigger manifest entry shape

For HTTP trigger exports, the plugin's `buildTriggerEntry` SHALL emit a manifest entry containing `name`, `type: "http"`, `method`, `body` (JSON Schema converted from Zod), `inputSchema` (JSON Schema for the composite payload), and `outputSchema` (JSON Schema for `HttpTriggerResult`). The plugin SHALL NOT emit `path`, `params`, or `query` fields on HTTP trigger entries.

The trigger-export validation SHALL check `typeof trigger === "function"` (not `typeof trigger.handler === "function"`); HTTP triggers are callables per the `sdk` and `http-trigger` capabilities.

#### Scenario: HTTP trigger manifest entry omits path and params

- **GIVEN** `export const cronitorWebhook = httpTrigger({ body: z.object({ id: z.string() }), handler })`
- **WHEN** the plugin's `buildTriggerEntry` emits the manifest entry
- **THEN** the entry SHALL contain `name: "cronitorWebhook"`, `type: "http"`, `method: "POST"`, `body`, `inputSchema`, `outputSchema`
- **AND** the entry SHALL NOT contain `path`, `params`, or `query` keys

#### Scenario: Callable trigger validation

- **GIVEN** `export const t = httpTrigger({...})` (a callable)
- **WHEN** `buildTriggerEntry` validates the export
- **THEN** the precondition check SHALL be `typeof trigger === "function"`

### Requirement: Cron trigger manifest emission from evaluated export

The plugin SHALL emit a cron trigger manifest entry by reading the `schedule` and `tz` properties off each `CronTrigger`-branded export of the evaluated workflow bundle. The plugin SHALL NOT perform AST transformation on `cronTrigger({...})` calls; the default `tz` is resolved by the SDK factory at construction time via `Intl.DateTimeFormat().resolvedOptions().timeZone`.

The evaluated cron-trigger export SHALL always carry a non-empty `.tz` (author-provided or factory-defaulted). The plugin SHALL pass that value through unchanged into the manifest.

#### Scenario: Plugin reads factory-defaulted tz

- **GIVEN** `export const nightly = cronTrigger({ schedule: "0 2 * * *", handler })` (no explicit tz) with build host timezone `Europe/Berlin`
- **WHEN** the plugin evaluates the bundle and walks exports
- **THEN** `nightly.tz` SHALL equal `"Europe/Berlin"`
- **AND** the manifest cron entry SHALL have `tz: "Europe/Berlin"`

#### Scenario: Plugin preserves explicit tz

- **GIVEN** `cronTrigger({ schedule: "0 2 * * *", tz: "UTC", handler })`
- **WHEN** the plugin builds
- **THEN** the manifest cron entry SHALL have `tz: "UTC"`

#### Scenario: No AST transform on cronTrigger calls

- **WHEN** the plugin processes a workflow source containing `cronTrigger({...})` calls
- **THEN** the plugin SHALL NOT modify the object-literal argument via MagicString or any AST rewrite

### Requirement: Manual trigger manifest emission from evaluated export

The plugin SHALL emit a manual trigger manifest entry by reading the `inputSchema` and `outputSchema` off each `ManualTrigger`-branded export and converting them to JSON Schema. The plugin SHALL NOT AST-transform `manualTrigger({...})` call expressions; default `inputSchema` (`z.object({})`) and `outputSchema` (`z.unknown()`) values are resolved by the SDK factory at construction time.

The emitted manifest entry SHALL have `type: "manual"`, `name` equal to the export identifier, and the converted `inputSchema` and `outputSchema`. It SHALL NOT carry `method`, `body`, `schedule`, `tz`, `path`, `params`, or `query`.

#### Scenario: Manual manifest entry with default schemas

- **GIVEN** `export const rerun = manualTrigger({ handler })`
- **WHEN** the plugin builds
- **THEN** the manifest SHALL contain `{ name: "rerun", type: "manual", inputSchema: <z.object({})>, outputSchema: <z.unknown()> }`
- **AND** the entry SHALL NOT contain `method`, `body`, `schedule`, or `tz`

#### Scenario: Manual manifest entry preserves author schemas

- **GIVEN** `manualTrigger({ input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }), handler })`
- **WHEN** the plugin builds
- **THEN** `inputSchema` and `outputSchema` in the manifest entry SHALL match the converted JSON Schemas

### Requirement: Trigger export identifier regex

The plugin SHALL validate each HTTP-trigger and manual-trigger branded export's identifier against the regex `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` during manifest emission. If the identifier does not match, the plugin SHALL fail the build with a clear error naming the workflow, the export, and the regex. This check exists because the export name IS the webhook URL's trailing segment (see `http-trigger` requirement "Trigger URL is derived from export name"); characters permitted in JS identifiers but not safe as opaque URL segments (`$`, unicode letters) are rejected at build time to prevent surprising URL behavior.

The identifier regex is intentionally stricter than the tenant regex: tenant/workflow segments permit leading digits and `-`; trigger names do not.

#### Scenario: Valid identifier passes

- **GIVEN** `export const cronitorWebhook = httpTrigger({...})`
- **WHEN** the plugin builds
- **THEN** the build SHALL succeed

#### Scenario: Identifier with `$` fails

- **GIVEN** `export const $weird = httpTrigger({...})`
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error naming the workflow, the export name `$weird`, and the regex

#### Scenario: Identifier longer than 63 chars fails

- **GIVEN** `export const aaaa<64 a's> = httpTrigger({...})`
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with a length-bound error

### Requirement: Build-time TypeScript type checking

The `workflowPlugin` SHALL run TypeScript type checking against all workflow entry files during the `buildStart` Vite hook. The build SHALL fail if any type errors are found. In watch mode (`build.watch` set), `buildStart` SHALL NOT run typechecking and SHALL proceed directly to bundling.

#### Scenario: Build fails on type error

- **WHEN** a workflow file contains a TypeScript type error (e.g., passing `{ wrong: true }` to an emit expecting `{ message: string }`)
- **AND** a production build is run (no `build.watch`)
- **THEN** the Vite build SHALL fail
- **AND** the error output SHALL include the file path, line, column, and source context for each type error

#### Scenario: Build succeeds with valid types

- **WHEN** all workflow files typecheck
- **AND** a production build runs
- **THEN** `buildStart` SHALL complete without error
- **AND** the build SHALL proceed to `generateBundle`

#### Scenario: Watch mode skips typechecking

- **WHEN** the Vite build runs in watch mode (`build.watch` set)
- **THEN** `buildStart` SHALL NOT run typechecking

### Requirement: Fixed strict TypeScript compiler options

The plugin SHALL use a hardcoded set of TypeScript compiler options for its typecheck pass. The plugin SHALL NOT read or require a `tsconfig.json` from the workflow project for build-time checking.

The fixed options SHALL be: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, `noEmit: true`, `isolatedModules: true`, `skipLibCheck: true`, `target: "esnext"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`.

#### Scenario: Strict mode enforced

- **WHEN** the plugin typechecks workflow files
- **THEN** the above options SHALL be the active compiler configuration

#### Scenario: No user-configurable tsconfig

- **WHEN** the plugin is configured
- **THEN** it SHALL NOT accept a `tsconfig` option
- **AND** it SHALL NOT search for or read `tsconfig.json` files

### Requirement: Typecheck scoped to declared workflow entries

The plugin SHALL type-check only the files listed in the `workflows` option and their transitive imports. It SHALL NOT glob or scan for additional TypeScript files.

#### Scenario: Only declared workflows checked

- **WHEN** the plugin is configured with `workflows: ["./cronitor.ts"]`
- **AND** other `.ts` files exist in the same directory
- **THEN** only `cronitor.ts` and its transitive imports SHALL be typechecked

### Requirement: TypeScript as peer dependency

The `@workflow-engine/sdk` package SHALL declare `typescript` as a peer dependency with a minimum version of `>=5.0.0`.

#### Scenario: Missing TypeScript installation

- **WHEN** a project uses `@workflow-engine/sdk/plugin` without `typescript` installed
- **THEN** the package manager SHALL warn about the missing peer dependency

### Requirement: Pretty typecheck error formatting

Type errors SHALL be formatted using `ts.formatDiagnosticsWithColorAndContext` so the output includes source lines, carets pointing at offending positions, and color.

#### Scenario: Typecheck error format

- **WHEN** a workflow file has a type error at line 15, column 3
- **THEN** the error output SHALL include the file path, line number, the source line content, and a caret indicating the error position

### Requirement: Build failure on workflow declaration errors

The plugin SHALL fail the Vite build if a workflow file declares zero or more than one `defineWorkflow(...)` exports, or if any action's `input` or `output` is not a Zod schema.

#### Scenario: Multiple defineWorkflow exports fails

- **GIVEN** two `defineWorkflow(...)` exports in one workflow file
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error indicating "at most one defineWorkflow per file"

#### Scenario: Action without a Zod input schema fails

- **GIVEN** an action whose `input` is not a Zod schema
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error identifying the action

