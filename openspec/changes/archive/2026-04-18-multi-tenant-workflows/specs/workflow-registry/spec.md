## MODIFIED Requirements

### Requirement: WorkflowRegistry is the central owner of workflow state

The runtime SHALL provide a `WorkflowRegistry` created with a `StorageBackend` and a `Logger`. It SHALL own validation, persistence, and in-memory state for all workflows across all tenants. Runners SHALL be keyed by `(tenant, name)`; the same `name` MAY exist in multiple tenants.

#### Scenario: Register a tenant from tarball files

- **WHEN** `register(tenant, files)` is called with `tenant = "acme"` and a `Map<string, string>` containing the root `manifest.json` and one `.js` per workflow
- **THEN** the registry SHALL validate the manifest, verify all workflow module sources exist, persist the tarball to the storage backend, build all in-memory workflows, and rebuild derived indexes
- **AND** it SHALL return the tenant name and the list of workflow names on success

#### Scenario: Register returns undefined on validation failure

- **WHEN** `register(tenant, files)` is called with invalid or incomplete files
- **THEN** the registry SHALL return `undefined`
- **AND** it SHALL log the error reason
- **AND** the existing tenant bundle (if any) SHALL remain unchanged

#### Scenario: Register atomically replaces the tenant's workflow set

- **WHEN** `register(tenant, files)` is called with a manifest whose `workflows` list differs from the current set for that tenant
- **THEN** every workflow in the new manifest SHALL be registered under `(tenant, name)`
- **AND** every workflow previously registered under that tenant but not present in the new manifest SHALL be retired
- **AND** the derived indexes SHALL be rebuilt

#### Scenario: Invalid register preserves existing tenant bundle

- **WHEN** `register(tenant, files)` is called with a tenant already present, and validation fails (e.g., missing module source)
- **THEN** the existing tenant bundle SHALL NOT be modified
- **AND** the in-memory state for that tenant SHALL NOT change
- **AND** the derived indexes SHALL NOT be rebuilt
- **AND** the runtime SHALL log the validation failure

### Requirement: Persist before rebuild

On a successful `register(tenant, files)`, the registry SHALL persist the tenant tarball to the storage backend at `workflows/<tenant>.tar.gz` before updating in-memory state. The persist step SHALL use a temp key + rename (`StorageBackend.move`) to achieve atomicity; intermediate crashes SHALL NOT leave a torn key. If persistence fails, the in-memory state SHALL NOT be updated.

#### Scenario: Successful persistence

- **WHEN** `register(tenant, files)` is called and the storage backend write succeeds
- **THEN** `workflows/<tenant>.tar.gz` SHALL contain the new tarball
- **AND** the in-memory workflows for the tenant SHALL be updated

#### Scenario: Persistence failure leaves old state intact

- **WHEN** `register(tenant, files)` is called and the storage backend write fails mid-way
- **THEN** `workflows/<tenant>.tar.gz` SHALL remain the previous successful version (or absent if there was no prior)
- **AND** no temp key SHALL be left dangling after the upload handler returns (best-effort cleanup)
- **AND** the in-memory state SHALL NOT change

### Requirement: Recover workflows from storage backend

The registry SHALL provide a `recover()` method that LISTs all keys matching `workflows/*.tar.gz` on startup, reads each, and loads every workflow entry into the registry keyed by `(tenant, name)`. It SHALL use the same validation logic as `register()`. Tenants whose bundle fails validation SHALL be skipped with an error log; other tenants SHALL continue loading.

#### Scenario: Recover loads all tenant bundles

- **GIVEN** the storage backend contains `workflows/acme.tar.gz` and `workflows/stefan.tar.gz`
- **WHEN** `recover()` is called
- **THEN** the registry SHALL contain every workflow from both tenant bundles

#### Scenario: Recover with empty storage

- **GIVEN** the storage backend contains no keys under `workflows/`
- **WHEN** `recover()` is called
- **THEN** the registry SHALL remain empty

#### Scenario: Recover skips invalid tenant bundle

- **GIVEN** the storage backend contains `workflows/broken.tar.gz` that fails validation
- **WHEN** `recover()` is called
- **THEN** the `broken` tenant SHALL be skipped
- **AND** the error SHALL be logged
- **AND** other tenants SHALL load normally

### Requirement: Derived indexes rebuilt eagerly

The registry SHALL maintain derived indexes that are rebuilt eagerly on every `register(tenant, ...)` call:
- `.actions` --- flat array of all actions across all tenants and workflows
- `.triggerRegistry` --- merged HTTP trigger registry keyed by `(tenant, workflow-name, trigger-path)`

#### Scenario: Actions from multiple tenants

- **GIVEN** tenant "acme"'s workflow "foo" has actions `[handleA]` and tenant "stefan"'s workflow "bar" has actions `[handleB, handleC]`
- **WHEN** both are registered
- **THEN** `registry.actions` SHALL contain `[handleA, handleB, handleC]`

#### Scenario: Rebuild after tenant replacement

- **GIVEN** tenants "acme" and "stefan" are registered
- **WHEN** `register("acme", <new tarball without any workflows>)` is called
- **THEN** `registry.actions` SHALL contain only "stefan"'s actions

### Requirement: Trigger conflict scoped by tenant

When a tenant is registered with trigger paths, those triggers SHALL be keyed by `(tenant, workflow-name, trigger-path)` in the HTTP trigger registry. Triggers in different tenants that share the same path SHALL NOT conflict. Within a single tenant, re-registering the same `(workflow-name, trigger-path)` SHALL replace the previous entry.

#### Scenario: Same trigger path in two tenants does not conflict

- **GIVEN** tenant "acme"'s workflow "foo" registers trigger path `"orders"` (POST)
- **WHEN** tenant "contoso"'s workflow "foo" is registered with the same trigger path `"orders"` (POST)
- **THEN** both triggers SHALL coexist, reachable via `/webhooks/acme/foo/orders` and `/webhooks/contoso/foo/orders` respectively

#### Scenario: Re-upload within a tenant replaces triggers

- **GIVEN** tenant "acme"'s workflow "foo" registered with trigger path `"orders"`
- **WHEN** tenant "acme" is re-registered and the new manifest for "foo" declares trigger path `"orders"` with a different handler
- **THEN** the trigger entry for `(acme, foo, orders)` SHALL point to the new handler

### Requirement: WorkflowRegistry exposes workflows with actions and triggers

The runtime SHALL provide a `WorkflowRegistry` that loads manifests at startup and exposes per-workflow `WorkflowRunner` objects. Each `WorkflowRunner` SHALL provide:
- `tenant`: string (the owning tenant)
- `name`: string
- `env`: `Readonly<Record<string, string>>`
- `sandbox`: the workflow's `Sandbox` instance
- `actions`: array of action descriptors `{ name, input, output }`
- `triggers`: array of typed trigger descriptors (e.g., `HttpTriggerDescriptor` with `name, type, path, method, body, params, query`)

The registry SHALL expose `lookupRunner(tenant, name)` which returns the current runner for the key or `undefined`. The registry SHALL NOT expose any event types or schemas.

#### Scenario: Registry exposes loaded workflows with tenant

- **GIVEN** two tenants each with one workflow loaded at startup
- **WHEN** the registry is queried
- **THEN** the registry SHALL expose two `WorkflowRunner` entries
- **AND** each entry SHALL have a `tenant` field matching its owning tenant
- **AND** each entry SHALL have `name`, `env`, `sandbox`, `actions`, `triggers`

#### Scenario: Lookup scoped by tenant

- **GIVEN** a workflow "foo" registered under tenants "acme" and "contoso"
- **WHEN** `lookupRunner("acme", "foo")` is called
- **THEN** the runner returned SHALL be the one belonging to "acme"
- **AND** `lookupRunner("contoso", "foo")` SHALL return the "contoso" runner
- **AND** `lookupRunner("other", "foo")` SHALL return `undefined`

## ADDED Requirements

### Requirement: Refcounted runners for hot-swap

When a tenant is re-registered (i.e. `register(tenant, newFiles)` is called where `tenant` already has runners), the registry SHALL implement version pinning for in-flight invocations as follows:

1. The new bundle SHALL be parsed and validated atomically (all-or-nothing); invalid bundles SHALL NOT touch live state (see "Invalid register preserves existing tenant bundle").
2. On successful validation, new `WorkflowRunner` + `Sandbox` instances SHALL be built for every workflow in the new manifest.
3. Under a short critical section, the registry SHALL atomically swap trigger-registry entries, `lookupRunner(tenant, name)` targets, and the tenant's public runner set to the new runners. Old runners SHALL be moved to a retiring set.
4. Each retiring runner SHALL carry a refcount equal to the number of in-flight invocations currently bound to it. The refcount SHALL decrement on every terminal event (`completed`, `failed`, or synthetic `trigger.error`) emitted by a bound invocation. When the refcount reaches zero, the retiring runner's sandbox SHALL be disposed.
5. New invocations triggered after the swap SHALL bind to the new runner via `lookupRunner(tenant, name)` (latest-at-dispatch semantics).

The retiring set SHALL be cleared on process shutdown, disposing any sandboxes still bound to long-lived invocations.

#### Scenario: In-flight invocation survives re-upload

- **GIVEN** tenant "acme"'s workflow "foo" is registered, and an invocation inv-A is in flight bound to runner_v1
- **WHEN** `register("acme", <new files>)` is called with a valid new bundle producing runner_v2
- **THEN** inv-A SHALL continue executing on runner_v1's sandbox
- **AND** new invocations triggered after the swap SHALL bind to runner_v2
- **AND** runner_v1 SHALL remain live until inv-A emits a terminal event

#### Scenario: Retiring runner disposed after last invocation finishes

- **GIVEN** a retiring runner_v1 with refcount 1 (inv-A bound)
- **WHEN** inv-A emits a terminal event (`completed`, `failed`, or `trigger.error`)
- **THEN** the runner_v1 refcount SHALL decrement to 0
- **AND** runner_v1's sandbox SHALL be disposed
- **AND** runner_v1 SHALL be removed from the retiring set

#### Scenario: Latest-at-dispatch for sub-invocations

- **GIVEN** tenant "acme" has runner_v1 with inv-A in flight, then runner_v2 replaces it
- **WHEN** inv-A dispatches a sub-invocation that would normally trigger another workflow in "acme"
- **THEN** the sub-invocation SHALL bind to the runner returned by `lookupRunner(...)` at dispatch time (runner_v2)
- **AND** the sub-invocation SHALL NOT be pinned to v1 transitively

#### Scenario: Workflow removed by re-upload, in-flight runner retained

- **GIVEN** tenant "acme"'s workflow "old" has invocation inv-A in flight, and the new manifest for "acme" does not include "old"
- **WHEN** `register("acme", <new files>)` succeeds
- **THEN** no runner for `(acme, old)` SHALL exist in the public registry
- **AND** `lookupRunner("acme", "old")` SHALL return `undefined` (new triggers for the removed workflow 404)
- **AND** inv-A SHALL continue on the retiring runner until terminal
- **AND** the retiring runner SHALL be disposed on refcount=0

#### Scenario: Shutdown disposes retiring runners

- **GIVEN** retiring runners with non-zero refcount (long-lived invocations)
- **WHEN** the process shuts down (normal or signal-driven)
- **THEN** each retiring runner's sandbox SHALL be disposed during shutdown
- **AND** bound invocations SHALL fail with the existing crash-termination path on next restart (via `recovery.recover()`)
