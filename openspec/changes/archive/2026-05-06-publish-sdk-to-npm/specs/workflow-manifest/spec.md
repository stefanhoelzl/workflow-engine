## ADDED Requirements

### Requirement: ManifestSchema rejects unknown fields

`ManifestSchema` and every nested `z.object(...)` subschema in `@workflow-engine/core` (including `workflowManifestSchema`, `actionManifestSchema`, `httpTriggerManifestSchema`, `cronTriggerManifestSchema`, `manualTriggerManifestSchema`, `imapTriggerManifestSchema`, `wsTriggerManifestSchema`, `queueManifestSchema`, and any `z.object` nested within them) SHALL be `.strict()`. Parsing a manifest that contains any field not declared in the schema SHALL throw a Zod validation error that names the offending key.

This contract supersedes Zod v4's default strip behavior, in which unknown keys are silently dropped. The strict contract ensures that an SDK version that introduces a new manifest field cannot have that field silently lost when uploaded to a runtime whose `ManifestSchema` does not yet recognize it. Such an upload SHALL fail loudly at the upload endpoint with a 422 response carrying the Zod-reported issues.

The discriminated union `triggerManifestSchema` inherits its variants' strictness; adding a trigger entry whose `type` is not in the discriminator continues to fail at the discriminator step (no change). Adding an unknown field to a known trigger variant now fails at that variant's strict check.

#### Scenario: Unknown top-level manifest key is rejected

- **GIVEN** a manifest of the form `{workflows: [...], futureField: "..."}`
- **WHEN** `ManifestSchema.parse()` is called on the manifest
- **THEN** parsing SHALL throw a Zod validation error
- **AND** the error SHALL identify `futureField` as an unrecognized key

#### Scenario: Unknown field on workflow entry is rejected

- **GIVEN** a manifest whose workflow entry contains a field not declared in `workflowManifestSchema` (e.g. `description: "..."`)
- **WHEN** `ManifestSchema.parse()` is called
- **THEN** parsing SHALL throw a Zod validation error naming the unrecognized key

#### Scenario: Unknown field on HTTP trigger is rejected

- **GIVEN** a manifest whose HTTP trigger entry contains a field not declared in `httpTriggerManifestSchema` (e.g. `priority: 1`)
- **WHEN** `ManifestSchema.parse()` is called
- **THEN** parsing SHALL throw a Zod validation error naming the unrecognized key

#### Scenario: Upload of manifest with unknown field returns 422

- **GIVEN** an authenticated upload to `POST /api/workflows/<owner>/<repo>` whose manifest contains an unrecognized field at any level
- **WHEN** the runtime parses the manifest through `ManifestSchema`
- **THEN** the response SHALL be `422 Unprocessable Entity`
- **AND** the response body SHALL include the Zod-reported issues identifying the unrecognized key

#### Scenario: Well-formed manifest with only declared fields passes

- **GIVEN** a manifest whose every field at every level is declared in the schema shape
- **WHEN** `ManifestSchema.parse()` is called
- **THEN** parsing SHALL succeed and return the typed manifest object
