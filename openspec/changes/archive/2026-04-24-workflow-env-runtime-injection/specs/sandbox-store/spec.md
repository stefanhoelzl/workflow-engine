## MODIFIED Requirements

### Requirement: SandboxStore composes full plugin catalog

The SandboxStore SHALL compose a standard plugin catalog for every production sandbox, in a fixed order compatible with `dependsOn` declarations:

```ts
plugins: [
  createWasiPlugin(runtimeWasiTelemetry),        // sandbox package
  createWebPlatformPlugin(),                     // sandbox-stdlib
  createFetchPlugin(),                           // sandbox-stdlib (uses hardenedFetch by default)
  createTimersPlugin(),                          // sandbox-stdlib
  createConsolePlugin(),                         // sandbox-stdlib
  createEnvInstallerPlugin(),                    // runtime
  createHostCallActionPlugin({ manifest }),      // runtime
  createSdkSupportPlugin(),                      // sdk
  createTriggerPlugin(),                         // runtime
]
```

`runtimeWasiTelemetry` SHALL be a setup function exported by the runtime that emits `wasi.clock_time_get` / `wasi.random_get` / `wasi.fd_write` leaf events for downstream dashboard/audit consumption.

`createEnvInstallerPlugin()` SHALL install `globalThis.workflow` via `installGuestGlobals` at Phase 2 and populate `workflow.env` from `ctx.envStrings` (equal to `manifest.env`) on every invocation, clearing it on `onRunFinished`. The env-installer plugin SHALL have no `dependsOn` and SHALL be placed in the composition before any plugin that might read `globalThis.workflow` during guest source initialization.

The store SHALL NOT include the trigger plugin or wasi telemetry plugin in test compositions when a silent sandbox is desired; that concern lives at the test-fixture layer.

#### Scenario: Default composition

- **GIVEN** the SandboxStore at runtime
- **WHEN** a new sandbox is constructed
- **THEN** the plugin list SHALL include all nine plugins named above
- **AND** their topo-sort SHALL be valid
- **AND** sandbox construction SHALL complete without error

#### Scenario: env-installer precedes user source

- **GIVEN** the production composition
- **WHEN** the sandbox progresses through plugin phases
- **THEN** `createEnvInstallerPlugin`'s Phase-2 source SHALL execute before the tenant's bundled IIFE evaluates
- **AND** `globalThis.workflow` SHALL be installed before `defineWorkflow` runs inside the guest

### Requirement: SandboxStore wires onEvent with metadata stamping

On every sandbox creation, the SandboxStore SHALL register an `onEvent` callback that stamps `tenant`, `workflow`, `workflowSha`, `invocationId` onto every incoming event before forwarding it to the bus. The metadata SHALL come from the "current run" state tracked by the store (populated when `sandbox.run()` is invoked, cleared after it returns).

The SandboxStore SHALL also pass `envStrings` (equal to the manifest's `env` field for the workflow being invoked) through to the sandbox as part of the `run` message's context, so the env-installer plugin can read it in its `onBeforeRunStarted` hook.

#### Scenario: envStrings delivered via run context

- **GIVEN** a workflow with `manifest.env = { REGION: "us-east-1" }`
- **WHEN** `sandbox.run(exportName, input)` is called via the store
- **THEN** the sandbox SHALL receive a `run` message whose ctx includes `envStrings: { REGION: "us-east-1" }`

#### Scenario: Metadata stamping remains unchanged

- **GIVEN** a run in progress
- **WHEN** the sandbox emits an event
- **THEN** the store's `onEvent` callback SHALL stamp `tenant`, `workflow`, `workflowSha`, `invocationId` onto the event
- **AND** the event SHALL be forwarded to the bus with those fields populated
