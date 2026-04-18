## MODIFIED Requirements

### Requirement: Action call resolution at build time

The plugin SHALL inject the action's identity into each `action({...})` call expression at build time by AST-transforming workflow source files. The transform SHALL run during Rollup's `transform` hook, parse the source via the bundled `acorn` parser (available via Vite / Rollup), walk top-level statements, and locate `ExportNamedDeclaration` nodes wrapping a `VariableDeclaration` of kind `const` whose declarator's initializer is a `CallExpression` to the bare identifier `action` with an `ObjectExpression` first argument. For each match, the transform SHALL inject a `name: "<exportedIdentifier>"` property into the object literal using MagicString (preserving sourcemaps).

The transform SHALL recognize only the canonical declaration form `export const X = action({...})`. Other declaration forms (detached exports, default exports, conditional definitions, factory wrappers, computed exports, etc.) SHALL NOT be transformed; they SHALL be caught by the post-bundle validation step (see scenario "Untransformed action exports fail the build").

After the bundle is built and the plugin walks the evaluated module exports for manifest derivation, the plugin SHALL verify that every `Action`-branded export has a non-empty `.name` property. If any exported action lacks a name, the build SHALL fail with `"Workflow \"<file>\": action \"<exportName>\" was not transformed at build time. Actions must be declared as: export const X = action({...})"`.

The plugin SHALL detect aliased action exports (the same callable exported under multiple names) by maintaining a `Map<Action, exportName>` while walking the evaluated exports; on the second observation of the same callable, the plugin SHALL fail the build with `ERR_ACTION_MULTI_NAME`.

The plugin SHALL NOT call `__setActionName` on action callables (the slot no longer exists in the SDK). The runtime SHALL NOT append a name-binder shim to the bundle (see `workflow-loading` capability).

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

### Requirement: Brand-symbol export discovery

The plugin SHALL discover the workflow's `Workflow` config, `Action`s, and `HttpTrigger`s (and other future trigger types) by walking the workflow file's exports and matching brand symbols on each export value. The plugin SHALL NOT use reference equality on handler functions for identification.

The plugin SHALL recognize:
- `Symbol.for("@workflow-engine/workflow")` -> workflow config (at most one per file)
- `Symbol.for("@workflow-engine/action")` -> action; identity = export name
- `Symbol.for("@workflow-engine/http-trigger")` -> HTTP trigger; identity = export name

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
