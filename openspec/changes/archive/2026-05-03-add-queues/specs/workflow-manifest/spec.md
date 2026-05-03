## ADDED Requirements

### Requirement: WorkflowManifest queues field

`WorkflowManifest` (validated by `ManifestSchema` in `@workflow-engine/core`) SHALL carry an optional `queues` field whose value is an array of `{name: string, schema: <JSON Schema>}` objects. Each entry SHALL describe one queue declared by the workflow. Existing manifests without the `queues` field SHALL parse as having an empty array (forward compatibility).

#### Scenario: Manifest serializes queues

- **GIVEN** a workflow declaring two queues `jobs` and `emails`
- **WHEN** `buildWorkflows()` produces the manifest
- **THEN** the manifest SHALL contain `queues: [{name: "jobs", schema: …}, {name: "emails", schema: …}]`
- **AND** the schemas SHALL be the JSON Schema produced by `z.toJSONSchema(zodSchema)`

#### Scenario: Older manifest parses cleanly

- **GIVEN** a manifest serialized before this change (no `queues` field)
- **WHEN** `ManifestSchema.parse(manifest)` runs
- **THEN** parsing SHALL succeed
- **AND** the parsed value's `queues` field SHALL be `[]`

### Requirement: Queue names are unique within a workflow manifest

`ManifestSchema` SHALL reject manifests where two queue entries within the same workflow share the same `name`, in addition to the build-time check enforced by the workflow build pipeline.

#### Scenario: Duplicate queue names rejected at parse time

- **GIVEN** a hand-crafted manifest with two queue entries both named `jobs`
- **WHEN** `ManifestSchema.parse(manifest)` runs
- **THEN** parsing SHALL fail with a Zod issue indicating the duplicate
