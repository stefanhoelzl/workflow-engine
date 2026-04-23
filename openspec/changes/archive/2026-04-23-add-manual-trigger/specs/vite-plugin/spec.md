# Vite Plugin Delta

## MODIFIED Requirements

### Requirement: Brand-symbol export discovery

The plugin SHALL discover the workflow's `Workflow` config, `Action`s, `HttpTrigger`s, `CronTrigger`s, `ManualTrigger`s (and other future trigger types) by walking the workflow file's exports and matching brand symbols on each export value. The plugin SHALL NOT use reference equality on handler functions for identification.

The plugin SHALL recognize:
- `Symbol.for("@workflow-engine/workflow")` -> workflow config (at most one per file)
- `Symbol.for("@workflow-engine/action")` -> action; identity = export name
- `Symbol.for("@workflow-engine/http-trigger")` -> HTTP trigger; identity = export name
- `Symbol.for("@workflow-engine/cron-trigger")` -> cron trigger; identity = export name
- `Symbol.for("@workflow-engine/manual-trigger")` -> manual trigger; identity = export name

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

#### Scenario: Plugin identifies manual trigger by brand

- **GIVEN** `export const rerun = manualTrigger({ handler })` in a workflow file
- **WHEN** the plugin walks exports
- **THEN** the plugin SHALL detect `rerun` as a manual trigger via the `MANUAL_TRIGGER_BRAND` symbol
- **AND** SHALL register it with `name: "rerun"`

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

## ADDED Requirements

### Requirement: Manual trigger manifest emission from evaluated export

The plugin SHALL emit a manual trigger manifest entry by reading the `inputSchema` and `outputSchema` properties off each `ManualTrigger`-branded export of the evaluated workflow bundle and converting them to JSON Schema the same way cron and http trigger schemas are converted. The plugin SHALL NOT perform AST transformation on `manualTrigger({...})` call expressions; default `inputSchema` and `outputSchema` values are resolved by the SDK factory at construction time (see the `sdk` and `manual-trigger` capability specs).

The emitted manifest entry SHALL have `type: "manual"`, `name` equal to the export identifier, and the converted `inputSchema` and `outputSchema`. The plugin SHALL NOT write `method`, `body`, `schedule`, `tz`, `path`, `params`, or `query` fields on manual entries.

The plugin SHALL validate each `ManualTrigger`-branded export's identifier against the same regex `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` already applied to HTTP trigger identifiers, and fail the build with a clear error message when the identifier does not match.

#### Scenario: Plugin emits manual manifest entry with default schemas

- **GIVEN** `export const rerun = manualTrigger({ handler: async () => {} })`
- **WHEN** the plugin evaluates the bundle and walks branded exports
- **THEN** the manifest SHALL contain a trigger entry with `name: "rerun"`, `type: "manual"`
- **AND** `inputSchema` SHALL be the JSON Schema for `z.object({})`
- **AND** `outputSchema` SHALL be the JSON Schema for `z.unknown()`
- **AND** the entry SHALL NOT contain `method`, `body`, `schedule`, or `tz`

#### Scenario: Plugin preserves author-provided schemas on manual entries

- **GIVEN** `export const reprocessOrder = manualTrigger({ input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }), handler })`
- **WHEN** the plugin evaluates the bundle and walks branded exports
- **THEN** the manifest trigger entry SHALL have `inputSchema` equal to the JSON Schema of the input
- **AND** `outputSchema` equal to the JSON Schema of the output

#### Scenario: Plugin does not AST-transform manual trigger call expressions

- **WHEN** the plugin processes a workflow source containing `manualTrigger({...})` calls
- **THEN** the plugin SHALL NOT modify the object-literal argument via MagicString or any AST rewrite
- **AND** the emitted bundle SHALL retain the original call shape as authored

#### Scenario: Manual trigger identifier with dollar sign fails build

- **GIVEN** `export const $weird = manualTrigger({ handler })` in workflow file `ops.ts`
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with an error identifying the workflow, the export name `$weird`, and the regex `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`
