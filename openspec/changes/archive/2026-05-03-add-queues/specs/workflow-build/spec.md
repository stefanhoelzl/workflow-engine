## ADDED Requirements

### Requirement: Brand-based discovery of queue exports

The workflow build pipeline SHALL discover queue declarations by inspecting each module export's value for the `QUEUE_BRAND` symbol, identical to how it discovers actions and triggers. Non-exported `defineQueue(...)` calls SHALL NOT appear in the manifest. Each discovered queue SHALL contribute a `{name, schema: <JSON Schema>}` entry to the workflow's manifest. When the factory was called without a `name` argument, the pipeline SHALL derive the queue's name from the export identifier (the same rule applied to `action` and `*Trigger`); when an explicit `name` was provided to the factory, the explicit value SHALL win.

#### Scenario: Exported queue with explicit name

- **GIVEN** a workflow file containing `export const jobs = defineQueue({name: "jobs", schema: ...});`
- **WHEN** `buildWorkflows()` runs
- **THEN** the resulting workflow manifest's `queues` array SHALL contain an entry with `name = "jobs"` and `schema` equal to the JSON Schema derived from the Zod schema

#### Scenario: Exported queue with derived name

- **GIVEN** a workflow file containing `export const emailRetry = defineQueue({schema: ...});`
- **WHEN** `buildWorkflows()` runs
- **THEN** the resulting workflow manifest's `queues` array SHALL contain an entry with `name = "emailRetry"` (derived from the export identifier)

#### Scenario: Non-exported queue is invisible

- **GIVEN** a workflow file containing only `const cache = defineQueue({name: "cache", schema: ...});` with no `export`
- **WHEN** `buildWorkflows()` runs
- **THEN** the resulting workflow manifest's `queues` array SHALL NOT contain an entry for `cache`

### Requirement: Build-time queue validation

The workflow build pipeline SHALL fail the build with a clear error when:
- two exported queues in the same workflow file share the same `name`
- a queue's schema is not representable in JSON Schema (e.g. `z.void()`, `z.undefined()` per the existing exclusion that applies to action output)
- a queue's resolved `name` (explicit or derived from the export identifier) does not match the regex `^[a-z][a-zA-Z0-9]*$`

The pipeline SHALL emit a build-time warning (not error) when a queue's `name` collides with an action or trigger name in the same workflow, since they live in different namespaces but the collision suggests author confusion.

#### Scenario: Duplicate queue names

- **GIVEN** a workflow exports two `defineQueue` calls both with `name: "jobs"`
- **WHEN** `buildWorkflows()` runs
- **THEN** the build SHALL fail with an error naming the duplicate and the workflow file

#### Scenario: Non-JSON-Schema schema

- **GIVEN** a workflow declares `defineQueue({name: "x", schema: z.void()})`
- **WHEN** `buildWorkflows()` runs
- **THEN** the build SHALL fail with an error explaining that `z.void()` has no JSON Schema representation

#### Scenario: Invalid queue name

- **GIVEN** a workflow declares `defineQueue({name: "Bad-Name", schema})`
- **WHEN** `buildWorkflows()` runs
- **THEN** the build SHALL fail with an error referencing the queue-name regex

#### Scenario: Name collision warning

- **GIVEN** a workflow exports both `action({...})` named `processOrder` and `defineQueue({name: "processOrder", schema})`
- **WHEN** `buildWorkflows()` runs
- **THEN** the build SHALL succeed
- **AND** a warning SHALL be emitted naming the colliding identifier
