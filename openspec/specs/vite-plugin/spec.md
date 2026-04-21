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

The plugin SHALL discover the workflow's `Workflow` config, `Action`s, `HttpTrigger`s, and `CronTrigger`s (and other future trigger types) by walking the workflow file's exports and matching brand symbols on each export value. The plugin SHALL NOT use reference equality on handler functions for identification.

The plugin SHALL recognize:
- `Symbol.for("@workflow-engine/workflow")` -> workflow config (at most one per file)
- `Symbol.for("@workflow-engine/action")` -> action; identity = export name
- `Symbol.for("@workflow-engine/http-trigger")` -> HTTP trigger; identity = export name
- `Symbol.for("@workflow-engine/cron-trigger")` -> cron trigger; identity = export name

While walking exports, the plugin SHALL maintain a `Map<callable, exportName>` keyed on each `Action`-branded value. If the same callable is observed under two export names, the plugin SHALL fail the build with `ERR_ACTION_MULTI_NAME`.

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

#### Scenario: Plugin identifies cron trigger by brand

- **GIVEN** `export const nightly = cronTrigger({ schedule: "0 2 * * *", handler })` in a workflow file
- **WHEN** the plugin walks exports
- **THEN** the plugin SHALL detect `nightly` as a cron trigger via the `CRON_TRIGGER_BRAND` symbol
- **AND** SHALL register it with `name: "nightly"`

#### Scenario: Plugin ignores unbranded exports

- **GIVEN** a workflow file with `export function helper() { ... }` and other non-action/trigger exports
- **WHEN** the plugin walks exports
- **THEN** non-branded exports SHALL be ignored for the manifest
- **AND** they SHALL still be bundled (they may be referenced by handlers)

#### Scenario: Aliased action detected by callable identity

- **GIVEN** a workflow file with `export const X = action({...})` and `export { X as Y };`
- **WHEN** the plugin walks the evaluated exports
- **THEN** the identity-set check SHALL detect that the same callable is bound to both `X` and `Y`
- **AND** the build SHALL fail with `ERR_ACTION_MULTI_NAME`

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

The plugin SHALL inject the action's identity into each `action({...})` call expression at build time by AST-transforming workflow source files. The transform SHALL run during Rollup's `transform` hook, parse the source via the bundled `acorn` parser (available via Vite / Rollup), walk top-level statements, and locate `ExportNamedDeclaration` nodes wrapping a `VariableDeclaration` of kind `const` whose declarator's initializer is a `CallExpression` to the bare identifier `action` with an `ObjectExpression` first argument. For each match, the transform SHALL inject a `name: "<exportedIdentifier>"` property into the object literal using MagicString (preserving sourcemaps).

The transform SHALL recognize only the canonical declaration form `export const X = action({...})`. Other declaration forms (detached exports, default exports, conditional definitions, factory wrappers, computed exports, etc.) SHALL NOT be transformed; they SHALL be caught by the post-bundle validation step (see scenario "Untransformed action exports fail the build").

After the bundle is built and the plugin walks the evaluated module exports for manifest derivation, the plugin SHALL verify that every `Action`-branded export has a non-empty `.name` property. If any exported action lacks a name, the build SHALL fail with `"Workflow \"<file>\": action \"<exportName>\" was not transformed at build time. Actions must be declared as: export const X = action({...})"`.

The plugin SHALL detect aliased action exports (the same callable exported under multiple names) by maintaining a `Map<Action, exportName>` while walking the evaluated exports; on the second observation of the same callable, the plugin SHALL fail the build with `ERR_ACTION_MULTI_NAME`.

The plugin SHALL NOT call `__setActionName` on action callables (the slot no longer exists in the SDK). The runtime SHALL NOT append a name-binder shim to the bundle (see `workflow-loading` capability).

For HTTP trigger exports, the plugin's `buildTriggerEntry` function SHALL emit a manifest entry containing `name`, `type: "http"`, `method`, `body` (JSON Schema), `inputSchema` (JSON Schema for the composite payload), and `outputSchema` (JSON Schema for `HttpTriggerResult`). The plugin SHALL NOT emit `path`, `params`, or `query` fields on HTTP trigger entries — these are removed from both the SDK surface and the manifest schema.

#### Scenario: Plugin injects name into action call expression

- **GIVEN** `export const sendNotification = action({ input: z.object({}), output: z.string(), handler: async () => "ok" })` in workflow file `cronitor.ts`
- **WHEN** the plugin transforms the source
- **THEN** the resulting source SHALL contain `name: "sendNotification"` as a property of the object literal passed to `action(...)`
- **AND** the post-bundle manifest SHALL contain an action entry with `name: "sendNotification"`

#### Scenario: Untransformed action exports fail the build

- **GIVEN** `const inner = action({...}); export { inner };` in a workflow file (detached export)
- **WHEN** the plugin builds
- **THEN** the AST transform SHALL leave the call unchanged
- **AND** the post-bundle validation step SHALL fail the build with the message indicating the action must be declared as `export const X = action({...})`

#### Scenario: Default-exported action fails the build

- **GIVEN** `export default action({...})` in a workflow file
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with `"action cannot be a default export; use export const"`

#### Scenario: Aliased action export fails the build

- **GIVEN** `export const X = action({...}); export { X as Y };` in a workflow file
- **WHEN** the plugin walks the evaluated exports
- **THEN** the plugin SHALL detect the same callable bound to two export names
- **AND** the build SHALL fail with `ERR_ACTION_MULTI_NAME`

#### Scenario: Trigger validation accepts callables

- **GIVEN** `export const t = httpTrigger({...})` (a callable per the `http-trigger` capability)
- **WHEN** the plugin's `buildTriggerEntry` validates the export
- **THEN** the precondition check SHALL be `typeof trigger === "function"` (not `typeof trigger.handler === "function"`)
- **AND** validation SHALL succeed when the trigger value is callable

#### Scenario: HTTP trigger manifest entry omits path and params

- **GIVEN** `export const cronitorWebhook = httpTrigger({ body: z.object({ id: z.string() }), handler })`
- **WHEN** the plugin's `buildTriggerEntry` emits the manifest entry
- **THEN** the entry SHALL contain `name: "cronitorWebhook"`, `type: "http"`, `method: "POST"`, `body`, `inputSchema`, `outputSchema`
- **AND** the entry SHALL NOT contain `path`, `params`, or `query` keys

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

### Requirement: Cron trigger manifest emission from evaluated export

The plugin SHALL emit a cron trigger manifest entry by reading the `schedule` and `tz` properties off each `CronTrigger`-branded export of the evaluated workflow bundle — the same pattern used today for `HttpTrigger.path` and `.method`. The plugin SHALL NOT perform AST transformation on `cronTrigger({...})` call expressions; the default `tz` value is resolved by the SDK factory at construction time (see the `sdk` and `cron-trigger` capability specs).

The evaluated cron-trigger export SHALL always carry a non-empty `.tz` property (either author-provided or factory-defaulted). The plugin SHALL pass that value through unchanged into the manifest.

#### Scenario: Plugin reads factory-defaulted tz from evaluated export

- **GIVEN** `export const nightly = cronTrigger({ schedule: "0 2 * * *", handler: async () => {} })` (no explicit tz) and a build host with `Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Berlin"`
- **WHEN** the plugin evaluates the bundle and walks branded exports
- **THEN** the evaluated `nightly.tz` SHALL equal `"Europe/Berlin"` (resolved by the SDK factory during bundle evaluation in Node)
- **AND** the manifest cron trigger entry SHALL have `tz: "Europe/Berlin"`

#### Scenario: Plugin preserves explicit tz from evaluated export

- **GIVEN** `export const nightly = cronTrigger({ schedule: "0 2 * * *", tz: "UTC", handler: async () => {} })`
- **WHEN** the plugin evaluates the bundle and walks branded exports
- **THEN** the manifest cron trigger entry SHALL have `tz: "UTC"`

#### Scenario: Plugin does not AST-transform cron trigger call expressions

- **WHEN** the plugin processes a workflow source containing `cronTrigger({...})` calls
- **THEN** the plugin SHALL NOT modify the object-literal argument via MagicString or any AST rewrite
- **AND** the emitted bundle SHALL retain the original call shape as authored

### Requirement: HTTP trigger export name is URL-safe

The vite plugin SHALL validate each `HttpTrigger`-branded export's identifier against the regex `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` during manifest emission. If the identifier does not match, the plugin SHALL fail the build with a clear error message naming the workflow, the export, and the regex. This validation SHALL run in `buildTriggerEntry` (or an equivalent location colocated with other per-trigger checks) and SHALL use the plugin's existing `ctx.error` surface so the failure halts the Vite build.

The validation exists because the export name IS the webhook URL's trailing segment (see the `http-trigger` capability requirement "Trigger URL is derived from export name"). Characters permitted in JS identifiers but not safe as opaque URL segments (notably `$`, unicode letters) are rejected at build time to prevent surprising URL behavior at request time. The identifier regex is intentionally stricter than the tenant regex: tenant/workflow segments permit leading digits and `-`; trigger names — constrained by JS identifier syntax anyway — do not.

#### Scenario: Valid identifier passes build

- **GIVEN** `export const cronitorWebhook = httpTrigger({...})` in a workflow file
- **WHEN** the plugin builds
- **THEN** the build SHALL succeed
- **AND** the manifest SHALL contain a trigger entry with `name: "cronitorWebhook"`

#### Scenario: Identifier with dollar sign fails build

- **GIVEN** `export const $weird = httpTrigger({...})` in workflow file `hub.ts`
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error identifying the workflow, the export name `$weird`, and the regex `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`

#### Scenario: Identifier longer than 63 characters fails build

- **GIVEN** `export const aaaa<...64 a's...> = httpTrigger({...})` (a 64-character identifier) in a workflow file
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error identifying the export name as exceeding the length bound

#### Scenario: Valid identifier using underscore prefix

- **GIVEN** `export const _privateHook = httpTrigger({...})` in a workflow file
- **WHEN** the plugin builds
- **THEN** the build SHALL succeed (underscore prefix is permitted by the regex)
