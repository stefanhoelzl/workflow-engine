## ADDED Requirements

### Requirement: Build runs ManifestSchema as a final-pass validator

After assembling the unsealed workflow manifest, `buildManifestFromMod` (in `packages/sdk/src/cli/build-workflows.ts`) SHALL run `workflowManifestSchema.safeParse(built)` as a final pass. For each Zod issue returned, the build SHALL invoke `buildContext.error(formatIssue(issue, built))` exactly once, surfacing one error per issue. The build SHALL NOT short-circuit on the first issue; all issues from a single parse SHALL be reported.

This requirement establishes `workflowManifestSchema` (in `@workflow-engine/core`) as the canonical home for any rule expressible on the serialized manifest. Build-time hand-written checks for serializable rules SHALL be removed in favor of the schema's enforcement (see REMOVED Requirements below).

#### Scenario: Build surfaces schema-level rejection as a single-line error

- **GIVEN** a workflow file producing a manifest with `triggers: []`
- **WHEN** the plugin builds
- **THEN** the build SHALL fail
- **AND** `buildContext.error` SHALL be invoked exactly once with a string of the form `Workflow "<name>": must declare at least one trigger`

#### Scenario: Build surfaces multiple schema issues as parallel errors

- **GIVEN** a workflow file producing a manifest with two distinct schema violations
- **WHEN** the plugin builds
- **THEN** `buildContext.error` SHALL be invoked twice, once per Zod issue
- **AND** each invocation SHALL receive a separately-formatted single-line string

## MODIFIED Requirements

### Requirement: Trigger export identifier regex

The `workflowManifestSchema` (in `@workflow-engine/core`) SHALL be the canonical validator for trigger and action `name` fields. The schema validates each trigger and action `name` against `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`; non-matching names cause `safeParse` to fail and the build's final-pass validator (see "Build runs ManifestSchema as a final-pass validator") SHALL surface the rejection via `buildContext.error(formatIssue(...))`.

The plugin SHALL NOT carry its own hand-written identifier-regex check. The export name becoming the manifest's trigger/action `name` is enforced by the discovery + entry-builder flow; the regex match is enforced exclusively by the schema.

This check exists because the export name IS the webhook URL's trailing segment (see `http-trigger` requirement "Trigger URL is derived from export name"); characters permitted in JS identifiers but not safe as opaque URL segments (`$`, unicode letters) are rejected to prevent surprising URL behavior.

The identifier regex is intentionally stricter than the tenant regex: tenant/workflow segments permit leading digits and `-`; trigger names do not.

#### Scenario: Valid identifier passes

- **GIVEN** `export const cronitorWebhook = httpTrigger({...})`
- **WHEN** the plugin builds
- **THEN** the build SHALL succeed

#### Scenario: Identifier with `$` fails via schema

- **GIVEN** `export const $weird = httpTrigger({...})`
- **WHEN** the plugin builds
- **THEN** the build SHALL fail
- **AND** the error SHALL be a `formatIssue`-rendered single-line string of the form `Workflow "<name>": http trigger "$weird": <issue message>`

#### Scenario: Identifier longer than 63 chars fails via schema

- **GIVEN** `export const aaaa<64 a's> = httpTrigger({...})`
- **WHEN** the plugin builds
- **THEN** the build SHALL fail with a length-bound error rendered via `formatIssue`

