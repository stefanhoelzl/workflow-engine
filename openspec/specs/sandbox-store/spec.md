# Sandbox Store Specification

## Purpose

Own tenant-scoped reuse of `Sandbox` instances in the runtime. Map `(tenant, workflow.sha)` pairs to long-lived sandboxes built on demand, wire per-workflow host methods at construction, and dispose every instance once on process shutdown.
## Requirements
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

The SandboxStore SHALL compose plugins per cached `(tenant, sha)` sandbox. For each new sandbox, it SHALL assemble the plugin list including `createHostCallActionPlugin({ manifest })` where `manifest` is the workflow's tenant-specific manifest. The Ajv validators compiled by `createHostCallActionPlugin` persist for the sandbox's lifetime (cached across runs).

The SandboxStore SHALL NOT construct `__hostCallAction` closures itself (that logic lives entirely inside the plugin's host-side handler); it only wires the plugin factory with the correct `{ manifest }` config.

The SandboxStore SHALL NOT append `action-dispatcher.js` (or any other dispatcher source) to the workflow bundle. The `createSdkSupportPlugin` handles dispatcher logic.

#### Scenario: Plugin receives tenant manifest

- **GIVEN** a SandboxStore serving tenant "acme" workflow "orders" at sha "abc123"
- **WHEN** the sandbox is constructed (on cache miss)
- **THEN** `createHostCallActionPlugin({ manifest: <orders.manifest for sha abc123> })` SHALL be added to the plugin list
- **AND** `createSdkSupportPlugin()` SHALL be added with `dependsOn` satisfied by host-call-action
- **AND** no dispatcher source SHALL be appended to `workflow.sourceBundle`

#### Scenario: Validators cached across runs

- **GIVEN** a cached sandbox for `(tenant, sha)`
- **WHEN** multiple invocations fire against the same sandbox
- **THEN** the Ajv validators compiled at construction SHALL be reused
- **AND** no recompilation SHALL occur between runs

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

### Requirement: SandboxStore composes full plugin catalog

The SandboxStore SHALL compose a standard plugin catalog for every production sandbox, in a fixed order compatible with `dependsOn` declarations:

```ts
plugins: [
  createWasiPlugin(runtimeWasiTelemetry),        // sandbox package
  createWebPlatformPlugin(),                     // sandbox-stdlib
  createFetchPlugin(),                           // sandbox-stdlib (uses hardenedFetch by default)
  createTimersPlugin(),                          // sandbox-stdlib
  createConsolePlugin(),                         // sandbox-stdlib
  createHostCallActionPlugin({ manifest }),      // runtime
  createSdkSupportPlugin(),                      // sdk
  createTriggerPlugin(),                         // runtime
]
```

`runtimeWasiTelemetry` SHALL be a setup function exported by the runtime that emits `wasi.clock_time_get` / `wasi.random_get` / `wasi.fd_write` leaf events for downstream dashboard/audit consumption. The store SHALL NOT include the trigger plugin or wasi telemetry plugin in test compositions when a silent sandbox is desired; that concern lives at the test-fixture layer.

#### Scenario: Default composition

- **GIVEN** the SandboxStore at runtime
- **WHEN** a new sandbox is constructed
- **THEN** the plugin list SHALL include all eight plugins named above
- **AND** their topo-sort SHALL be valid
- **AND** sandbox construction SHALL complete without error

### Requirement: SandboxStore wires onEvent with metadata stamping

On every sandbox creation, the SandboxStore SHALL register an `onEvent` callback that stamps `tenant`, `workflow`, `workflowSha`, `invocationId` onto every incoming event before forwarding it to the bus. The metadata SHALL come from the "current run" state tracked by the store (populated when `sandbox.run()` is invoked, cleared after it returns).

#### Scenario: Metadata stamping on event forward

- **GIVEN** a sandbox with events flowing from a run
- **WHEN** the sandbox emits any event
- **THEN** the store's `onEvent` callback SHALL add tenant/workflow/workflowSha/invocationId to the event
- **AND** the stamped event SHALL reach `bus.emit`
- **AND** the tenant SHALL match the tenant that owns the cached sandbox (invariant I-T2)

