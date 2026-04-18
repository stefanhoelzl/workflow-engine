## MODIFIED Requirements

### Requirement: WorkflowRegistry is the central owner of workflow state

The runtime SHALL provide a `WorkflowRegistry` created with an optional `StorageBackend` and a `Logger`. It SHALL own manifest validation, persistence, and in-memory metadata for all registered workflows across all tenants. It SHALL NOT own sandboxes, `WorkflowRunner` objects, or any execution-side state; sandbox lifecycle is owned by the `SandboxStore` (see the `sandbox-store` capability), and invocation dispatch is owned by the `Executor`.

#### Scenario: Register a tenant from a file map

- **WHEN** `registerTenant(tenant, files)` is called with a `Map<string, string>` containing `manifest.json` and the bundled workflow module files
- **THEN** the registry SHALL validate the manifest against `ManifestSchema`, verify each workflow's bundle file exists in the file map, persist the tarball to the storage backend (if configured and requested), and replace the in-memory metadata for `tenant` with the newly registered workflows
- **AND** it SHALL rebuild the derived HTTP trigger index scoped to `tenant`
- **AND** it SHALL return a `RegisterResult` with `ok: true` on success and `ok: false` with an error message on failure

#### Scenario: Register returns a failure result on validation error

- **WHEN** `registerTenant(tenant, files)` is called with an invalid or incomplete file map
- **THEN** the registry SHALL return `{ ok: false, error }` and SHALL log the reason
- **AND** the in-memory metadata for `tenant` SHALL remain unchanged

#### Scenario: Register replaces all workflows for the tenant

- **WHEN** `registerTenant(tenant, files)` is called with a new manifest
- **THEN** all existing workflow metadata for `tenant` SHALL be discarded and replaced
- **AND** the HTTP trigger index for `tenant` SHALL be rebuilt
- **AND** sandboxes held by the `SandboxStore` for `(tenant, oldSha)` keys SHALL NOT be disposed (see `sandbox-store`)

### Requirement: WorkflowRegistry exposes metadata lookup

The runtime SHALL provide a `WorkflowRegistry.lookup(tenant, method, path)` method that returns `{ workflow, triggerName, validator }` when a matching HTTP trigger exists for `(tenant, method, path)`, or `undefined` otherwise. The returned `workflow` SHALL be the parsed `WorkflowManifest`. The registry SHALL NOT expose a `WorkflowRunner` type, a `runners[]` array, or a `sandbox` reference on any returned value.

#### Scenario: Lookup returns the matching workflow and trigger

- **GIVEN** a tenant with two workflows, one of which declares an HTTP trigger on `POST /orders`
- **WHEN** `registry.lookup(tenant, "POST", "/orders")` is called
- **THEN** the registry SHALL return `{ workflow, triggerName: "ordersWebhook", validator }`
- **AND** `workflow` SHALL be the `WorkflowManifest` that declared the trigger

#### Scenario: Lookup returns undefined on no match

- **WHEN** `registry.lookup(tenant, method, path)` is called with values that do not match any registered trigger for that tenant
- **THEN** the registry SHALL return `undefined`

#### Scenario: Lookup is tenant-scoped

- **GIVEN** tenant `A` and tenant `B` both register a workflow with an HTTP trigger on the same path
- **WHEN** `registry.lookup("A", method, path)` is called
- **THEN** the registry SHALL return `A`'s workflow manifest, not `B`'s

### Requirement: Recover workflows from storage backend

The registry SHALL provide a `recover()` method that loads all tenant tarballs from the storage backend's `workflows/` prefix at startup and invokes `registerTenant` for each. Recovery SHALL use the same validation logic as `registerTenant`.

#### Scenario: Recover loads persisted tenant tarballs

- **GIVEN** the storage backend contains `workflows/acme.tar.gz` and `workflows/globex.tar.gz`
- **WHEN** `recover()` is called
- **THEN** both tenants' metadata SHALL be registered from their tarballs
- **AND** the derived HTTP trigger indexes SHALL be populated

#### Scenario: Recover with empty storage

- **WHEN** `recover()` is called and no keys exist under `workflows/`
- **THEN** the registry SHALL remain empty

#### Scenario: Recover without storage backend

- **GIVEN** no storage backend is configured
- **WHEN** `recover()` is called
- **THEN** `recover()` SHALL be a no-op

#### Scenario: Recover skips invalid tenants

- **GIVEN** the storage backend contains a tenant tarball with an invalid manifest
- **WHEN** `recover()` is called
- **THEN** the invalid tenant SHALL be skipped
- **AND** the error SHALL be logged
- **AND** other valid tenants SHALL still be registered

### Requirement: Derived indexes rebuilt eagerly

The registry SHALL maintain a per-tenant HTTP trigger index that is rebuilt eagerly on every `registerTenant` call. The index SHALL map `(tenant, method, path)` tuples to `{ workflow, triggerName, validator }`. Tenant-scoped: a trigger registered for tenant `A` SHALL NOT be reachable via a lookup for tenant `B`.

#### Scenario: Rebuild after re-registration

- **GIVEN** a tenant with workflow `v1` registered
- **WHEN** the tenant re-registers with workflow `v2` (different trigger paths)
- **THEN** `v1`'s triggers SHALL no longer appear in lookup results
- **AND** `v2`'s triggers SHALL be reachable

## REMOVED Requirements

### Requirement: WorkflowRegistry exposes workflows with actions and triggers

**Reason**: The `WorkflowRunner` abstraction is removed by this change. The metadata it carried (name, env, actions, triggers) lives in the `WorkflowManifest` returned by `registry.lookup`; sandbox access moves to the `SandboxStore`. No consumer should ever need a bundled `(sandbox, metadata)` object — the executor reaches into both individually.

**Migration**: Consumers that previously accessed `registry.runners[i].sandbox` SHALL use `SandboxStore.get(tenant, workflow, bundleSource)` instead. Consumers that previously accessed `registry.runners[i].{name, env, actions, triggers}` SHALL use `registry.lookup(tenant, method, path)` and read the returned `WorkflowManifest`. Dashboard / trigger UI code migrates to `registry.list()` returning tenant-scoped manifest entries (introduced as part of this change where needed).

### Requirement: Trigger conflict override

**Reason**: Cross-workflow trigger overrides no longer exist. Under multi-tenant isolation, a trigger from tenant `A` and a trigger from tenant `B` on the same path are both reachable via `lookup(A, ...)` and `lookup(B, ...)` respectively. Within a tenant, two workflows registering the same path in a single `registerTenant` call is a manifest validation error (existing behavior). The "last registration wins" override across workflows within a tenant is removed as a documented behavior because `registerTenant` always replaces all of the tenant's workflows atomically.

**Migration**: Manifests that rely on cross-registration overrides SHALL instead declare all trigger paths once per tenant.
