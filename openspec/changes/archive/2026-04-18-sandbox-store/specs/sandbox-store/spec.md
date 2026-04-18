## ADDED Requirements

### Requirement: SandboxStore provides per-`(tenant, sha)` sandbox access

The runtime SHALL provide a `SandboxStore` component that maps `(tenant, workflow.sha)` pairs to `Sandbox` instances. The store SHALL be the sole runtime-internal accessor for workflow sandboxes. The store SHALL build sandboxes lazily on the first `get` for a given key and SHALL hold them for the lifetime of the store.

```ts
interface SandboxStore {
  get(
    tenant: string,
    workflow: WorkflowManifest,
    bundleSource: string,
  ): Promise<Sandbox>;
  dispose(): void;
}
```

#### Scenario: First get for a key builds a new sandbox

- **GIVEN** a freshly constructed `SandboxStore` with no cached sandboxes
- **WHEN** `store.get(tenant, workflow, bundleSource)` is called for the first time
- **THEN** the store SHALL construct a new sandbox via the injected `SandboxFactory`
- **AND** the store SHALL retain a reference to that sandbox keyed on `(tenant, workflow.sha)`
- **AND** the returned promise SHALL resolve to the newly constructed sandbox

#### Scenario: Subsequent get for the same key returns the cached sandbox

- **GIVEN** a store that has previously built a sandbox for `(tenant, workflow.sha)`
- **WHEN** `store.get(tenant, workflow, bundleSource)` is called a second time with the same `tenant` and a workflow manifest whose `sha` matches the first call
- **THEN** the store SHALL resolve to the same sandbox reference
- **AND** the store SHALL NOT invoke the `SandboxFactory`

#### Scenario: Different tenants with identical shas get distinct sandboxes

- **GIVEN** two tenants `A` and `B` each registering workflows with byte-identical bundles and identical `workflow.sha`
- **WHEN** `store.get("A", workflow, bundleSource)` and `store.get("B", workflow, bundleSource)` are both called
- **THEN** the store SHALL return two distinct sandbox instances
- **AND** module-scope state mutations in tenant `A`'s sandbox SHALL NOT be observable from tenant `B`'s sandbox

#### Scenario: Different shas within a tenant get distinct sandboxes

- **GIVEN** a tenant that previously registered workflow `v1` with sha `s1` and has now re-uploaded the workflow as `v2` with sha `s2`
- **WHEN** `store.get(tenant, v2, bundleSource2)` is called
- **THEN** the store SHALL build a new sandbox for `(tenant, s2)`
- **AND** the `(tenant, s1)` sandbox SHALL remain in the store untouched

### Requirement: SandboxStore owns per-workflow `__hostCallAction` construction

The `SandboxStore` SHALL, on sandbox construction, build the per-workflow `__hostCallAction` closure from the supplied `WorkflowManifest`. The closure SHALL validate action inputs against manifest-declared JSON Schemas using Ajv and SHALL audit-log each action invocation. The store SHALL pass the closure as a host method to `SandboxFactory.create`.

#### Scenario: Host method is wired per workflow

- **WHEN** the store builds a sandbox for `(tenant, workflow.sha)`
- **THEN** the sandbox SHALL be constructed with a `__hostCallAction` host method whose input validators are compiled from `workflow.actions`
- **AND** the sandbox's action dispatcher SHALL reach the host validator via the installed `__hostCallAction` global before it is captured and deleted by the action-dispatcher IIFE

#### Scenario: Validator is compiled once per sandbox

- **GIVEN** a sandbox built for `(tenant, workflow.sha)`
- **WHEN** multiple invocations of the same workflow reach `__hostCallAction`
- **THEN** the same compiled Ajv validator SHALL be used for every call
- **AND** the validator SHALL NOT be rebuilt per invocation

### Requirement: Sandboxes live for the lifetime of the store

The `SandboxStore` SHALL NOT dispose individual sandboxes during normal operation. The store SHALL provide a public `dispose()` method that disposes every sandbox it holds; this method SHALL be invoked only on process shutdown. The store SHALL NOT expose any public API for evicting or removing individual sandboxes.

#### Scenario: Re-upload does not dispose the old sandbox

- **GIVEN** a store holding a sandbox for `(tenant, oldSha)`
- **WHEN** the same tenant re-registers the workflow with a new `sha`
- **THEN** the `(tenant, oldSha)` sandbox SHALL remain in the store
- **AND** the sandbox SHALL NOT be disposed

#### Scenario: In-flight invocation completes on the orphaned sandbox

- **GIVEN** an in-flight invocation dispatched to the `(tenant, oldSha)` sandbox
- **WHEN** the tenant re-registers the workflow with a new `sha` before the invocation completes
- **THEN** the in-flight invocation SHALL complete successfully against the `(tenant, oldSha)` sandbox
- **AND** a new invocation issued after the re-registration SHALL be dispatched to the `(tenant, newSha)` sandbox (built on demand if not yet cached)

#### Scenario: Shutdown disposes every cached sandbox

- **GIVEN** a store holding sandboxes for multiple `(tenant, sha)` keys
- **WHEN** `store.dispose()` is called
- **THEN** every cached sandbox SHALL have its `dispose()` method called
- **AND** the store SHALL release all references to the disposed sandboxes

### Requirement: SandboxStore is constructed with a factory and logger

The `SandboxStore` SHALL be constructed via a factory function accepting `{ sandboxFactory, logger }`. The store SHALL delegate sandbox construction to `sandboxFactory.create(source, options)` and SHALL emit info-level log entries on cache miss (sandbox constructed) via the injected logger.

#### Scenario: Factory delegation

- **WHEN** `createSandboxStore({ sandboxFactory, logger })` is called
- **THEN** the returned store SHALL retain references to both dependencies
- **AND** every `get` that misses SHALL call `sandboxFactory.create(source, options)` exactly once
