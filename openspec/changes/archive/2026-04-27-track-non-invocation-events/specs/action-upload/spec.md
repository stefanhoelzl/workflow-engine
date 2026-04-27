## ADDED Requirements

### Requirement: Upload handler emits system.upload per workflow with sha-based dedup

After `WorkflowRegistry.registerOwner()` succeeds for an upload, the upload handler SHALL emit one `system.upload` event per workflow in the bundle, subject to sha-based dedup: an event SHALL be emitted for a given `(owner, repo, workflow.name, workflow.sha)` ONLY if no `system.upload` event with that exact tuple already exists in the EventStore.

For each workflow the handler SHALL:

1. Query the EventStore for `kind = 'system.upload' AND owner = ? AND repo = ? AND workflow = ? AND workflowSha = ?`. If a row exists, skip the workflow.
2. Otherwise emit an `InvocationEvent` with `kind: "system.upload"`, `name: <workflow.name>`, fresh `id` matching `^evt_[A-Za-z0-9_-]{8,}$` (also serving as `invocationId`), `seq: 0`, `ref: 0`, `ts: 0`, `at: new Date().toISOString()`, `owner`, `repo`, `workflow: workflow.name`, `workflowSha: workflow.sha`, `input: <per-workflow manifest sub-snapshot>`, `meta.dispatch: {source: "upload", user: <authenticated user from request context>}`.

The handler SHALL emit events sequentially in manifest order. Emission failures (bus consumer rejection on a strict consumer) follow the same crash-on-durability-failure semantics as any other strict-consumer emission per the bus contract; no per-workflow rollback is required.

The handler SHALL NOT emit `system.upload` events on `415` (invalid archive) or `422` (manifest validation failure) responses — events are emitted only after a successful registration.

#### Scenario: First upload of a (workflow, sha) emits a system.upload event per workflow

- **GIVEN** a successful upload to `(owner: "acme", repo: "billing")` containing two workflows: `demo @ sha abc123` and `report @ sha def456`, neither previously seen
- **WHEN** the handler completes registration successfully
- **THEN** the EventStore SHALL gain exactly two new `system.upload` events
- **AND** one event SHALL have `name: "demo"`, `workflowSha: "abc123"`
- **AND** the other SHALL have `name: "report"`, `workflowSha: "def456"`
- **AND** both events SHALL carry `meta.dispatch = {source: "upload", user: <session user>}`

#### Scenario: Re-upload of identical bytes emits no events

- **GIVEN** a previously-recorded `system.upload` event for `(acme, billing, demo, abc123)` and `(acme, billing, report, def456)`
- **WHEN** the same user re-uploads the same bundle
- **THEN** the EventStore SHALL gain ZERO new `system.upload` events

#### Scenario: Mixed re-upload emits only changed workflows

- **GIVEN** a previously-recorded `system.upload` event for `(acme, billing, demo, abc123)` only
- **WHEN** a re-upload arrives where `demo` is unchanged at `abc123` and `report` is newly present at `def456`
- **THEN** the EventStore SHALL gain exactly one new event with `name: "report"`, `workflowSha: "def456"`
- **AND** SHALL NOT gain a new event for `demo`

#### Scenario: Failed upload emits no system.upload event

- **GIVEN** a request whose archive is invalid gzip
- **WHEN** the handler returns `415`
- **THEN** the EventStore SHALL gain ZERO `system.upload` events

#### Scenario: Manifest validation failure emits no system.upload event

- **GIVEN** a request whose manifest fails `ManifestSchema` validation
- **WHEN** the handler returns `422`
- **THEN** the EventStore SHALL gain ZERO `system.upload` events
