## MODIFIED Requirements

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

## ADDED Requirements

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
