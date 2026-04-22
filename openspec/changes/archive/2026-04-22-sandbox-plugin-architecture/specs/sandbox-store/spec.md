## MODIFIED Requirements

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

## ADDED Requirements

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
