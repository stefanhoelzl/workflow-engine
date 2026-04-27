## MODIFIED Requirements

### Requirement: SandboxStore composes the production plugin catalog

The SandboxStore SHALL compose a standard plugin catalog for every production sandbox, in a fixed order compatible with plugin `dependsOn` declarations:

```ts
plugins: [
  createWasiPlugin(runtimeWasiTelemetry),   // sandbox package (WASI routing)
  createWebPlatformPlugin(),                // sandbox-stdlib (all safe-globals)
  createFetchPlugin(),                      // sandbox-stdlib (hardenedFetch default)
  createTimersPlugin(),                     // sandbox-stdlib
  createConsolePlugin(),                    // sandbox-stdlib
  createHostCallActionPlugin({ manifest }), // runtime (schema validators rehydrated from manifest)
  createSdkSupportPlugin(),                 // sdk (__sdk.dispatchAction)
  createTriggerPlugin(),                    // runtime (trigger.* lifecycle emission)
]
```

`runtimeWasiTelemetry` SHALL be a setup function exported by the runtime that emits `wasi.clock_time_get` / `wasi.random_get` / `wasi.fd_write` leaf events. The store SHALL NOT append any dispatcher source to the workflow bundle; the SDK's `createSdkSupportPlugin` owns dispatcher logic.

Test compositions MAY omit the trigger plugin and wasi-telemetry when a silent sandbox is desired; that concern lives at the test-fixture layer, not in the production store.

#### Scenario: Production composition loads all eight plugins

- **WHEN** a production sandbox is constructed
- **THEN** the plugin list SHALL include the eight plugins named above
- **AND** the plugin composition's topological sort SHALL be valid
- **AND** sandbox construction SHALL complete without error

#### Scenario: No dispatcher source is appended

- **GIVEN** a tenant workflow bundle
- **WHEN** the SandboxStore constructs the sandbox
- **THEN** `sandbox({source: <bundle>, plugins: [...]})` SHALL be called with `source` unmodified
- **AND** no runtime-side source SHALL be concatenated, prepended, or appended
