## MODIFIED Requirements

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

## ADDED Requirements

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
