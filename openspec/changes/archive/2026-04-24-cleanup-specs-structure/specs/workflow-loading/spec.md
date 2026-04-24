## REMOVED Requirements

All requirements are absorbed into `workflow-registry` under a new "Sandbox loading" grouping. Workflow loading is the read side of the registry's tenant bundle persistence; splitting it into its own capability duplicates ownership.

### Requirement: Workflow loading instantiates one sandbox per workflow

**Reason**: Absorption. The loading-creates-one-sandbox-per-(tenant,sha) contract via the SandboxStore is really a registry load-path concern.

**Migration**: See `workflow-registry` — same contract (one cached sandbox per `(tenant, sha)`; bundle source passed unmodified to `sandbox({source, plugins})`; no runtime source appending; dispatcher logic in `createSdkSupportPlugin`). Private bindings (`__sdkDispatchAction`, `__reportErrorHost`, `__wptReport`) auto-deleted by Phase 3; user source runs in Phase 4 seeing only public globals and `__sdk`.

### Requirement: Workflow loading resolves env at load time

**Reason**: Same absorption.

**Migration**: See `workflow-registry` — `env` resolution happens at build time (reading `process.env`, applying defaults); the runtime reads resolved values from the manifest. Manifest `env` map applied to the loaded workflow object.
