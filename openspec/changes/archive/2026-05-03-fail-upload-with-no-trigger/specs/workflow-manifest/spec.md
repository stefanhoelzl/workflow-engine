## ADDED Requirements

### Requirement: Workflow declares at least one trigger

`workflowManifestSchema` SHALL reject any workflow whose `triggers` array is empty. Manifests where `workflow.triggers.length === 0` SHALL fail validation with a Zod issue identifying the workflow.

A workflow with no triggers cannot fire anything; accepting it silently registers dead bytes in the workflow registry and offers no feedback loop to the author. The rule is enforced at the schema layer so it applies uniformly to manifests produced by the SDK build, hand-crafted manifests, and any future API client.

#### Scenario: Workflow with zero triggers fails

- **WHEN** a manifest contains a workflow with `triggers: []`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error
- **AND** the issue SHALL identify the empty-triggers condition

#### Scenario: Workflow with at least one trigger passes

- **GIVEN** a manifest with a workflow whose `triggers` contains one or more entries
- **WHEN** parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed (subject to other requirements)

### Requirement: Trigger names unique within a workflow

`workflowManifestSchema` SHALL reject any workflow whose `triggers` array contains two or more entries with the same `name`. Uniqueness is per-workflow; different workflows MAY use the same trigger names.

This rule is implicit in the build pipeline today (JS export names are unique within a module), but schema-level enforcement closes the gap for hand-crafted manifests and future non-build callers.

#### Scenario: Duplicate trigger names within a workflow fail

- **GIVEN** a manifest with a workflow whose `triggers` contains two entries both named `"webhook"`
- **WHEN** parsed through `ManifestSchema`
- **THEN** parsing SHALL throw a validation error identifying the duplicate name

#### Scenario: Same trigger name in different workflows passes

- **GIVEN** a manifest with two workflows each containing a trigger named `"webhook"`
- **WHEN** parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed

### Requirement: Action names unique within a workflow

`workflowManifestSchema` SHALL reject any workflow whose `actions` array contains two or more entries with the same `name`. Uniqueness is per-workflow.

#### Scenario: Duplicate action names within a workflow fail

- **GIVEN** a manifest with a workflow whose `actions` contains two entries both named `"sendMail"`
- **WHEN** parsed through `ManifestSchema`
- **THEN** parsing SHALL throw a validation error identifying the duplicate name

### Requirement: HTTP trigger response.headers excludes reserved headers

`httpTriggerManifestSchema` SHALL reject any HTTP trigger entry whose `response.headers` JSON Schema declares a header in `RESERVED_RESPONSE_HEADERS` (the platform-owned set: `content-type`, `content-length`, `transfer-encoding`, `connection`, `keep-alive`, `host`, etc., as exported from `@workflow-engine/core`). The check SHALL walk the JSON Schema's top-level `properties` keys, lower-case each, and reject the manifest if any match a reserved header.

This rule was previously enforced at build time only. Migrating it to the schema makes it enforceable on hand-crafted manifests and lets the same `formatIssue`-rendered error surface uniformly for build-time and server-side rejections.

#### Scenario: Response headers schema with `Content-Type` rejected

- **GIVEN** a manifest with an HTTP trigger whose `response.headers` JSON Schema has a property `Content-Type`
- **WHEN** parsed through `ManifestSchema`
- **THEN** parsing SHALL throw a validation error identifying the reserved header

#### Scenario: Response headers schema with author-defined headers passes

- **GIVEN** a manifest with an HTTP trigger whose `response.headers` JSON Schema has a property `x-app-version`
- **WHEN** parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed

### Requirement: Issue formatter exported from core

`@workflow-engine/core` SHALL export a `formatIssue(issue, parsedValue)` function that renders a single Zod issue from a `workflowManifestSchema` parse failure into a single-line string of the form `Workflow "<name>": <type> trigger "<name>": <suffix>` (or `Workflow "<name>": action "<name>": <suffix>`) by walking `issue.path` and reading `parsedValue.triggers[i].type` and `.name` (or `parsedValue.actions[i].name`). When the path does not target a known collection, the formatter SHALL fall back to a path-string representation suffixed by the issue's message.

The formatter is the single shared rendering path used by both the SDK build (when surfacing `safeParse` results via `buildContext.error`) and the runtime upload handler (when populating the `formatted` field on each 422 issue).

#### Scenario: Cron schedule issue rendered with full context

- **GIVEN** a parsed manifest whose workflow is named `"demo"` and whose `triggers[1]` is a cron entry named `"everyFiveMinutes"` with `schedule: ""`
- **WHEN** `formatIssue(issue, parsedValue)` is called for the schedule violation
- **THEN** the result SHALL be `Workflow "demo": cron trigger "everyFiveMinutes": <issue message>`

#### Scenario: Top-level workflow rule rendered with workflow context

- **GIVEN** a parsed manifest whose workflow is named `"demo"` and has `triggers: []`
- **WHEN** `formatIssue(issue, parsedValue)` is called for the empty-triggers violation
- **THEN** the result SHALL be `Workflow "demo": must declare at least one trigger`

#### Scenario: Path inside a known collection's nested field

- **GIVEN** a parsed manifest whose workflow is named `"demo"` and whose `triggers[0]` is an http entry named `"webhook"` with a reserved header in `response.headers.properties`
- **WHEN** `formatIssue(issue, parsedValue)` is called for the reserved-header violation
- **THEN** the result SHALL be `Workflow "demo": http trigger "webhook": <issue message>`

#### Scenario: Path outside known collections falls back to path-string

- **GIVEN** an issue whose path does not start with `"triggers"` or `"actions"` and whose target is not the workflow root
- **WHEN** `formatIssue(issue, parsedValue)` is called
- **THEN** the result SHALL include the workflow name and a path-string representation of `issue.path` followed by the issue message
