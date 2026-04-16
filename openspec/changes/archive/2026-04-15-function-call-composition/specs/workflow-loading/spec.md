## ADDED Requirements

### Requirement: Workflow loading instantiates one sandbox per workflow

The runtime SHALL load each workflow's manifest, read the per-workflow bundle file path from `manifest.module`, and instantiate exactly one `Sandbox` per workflow with that bundle source. The sandbox SHALL be created via `sandbox(source, methods)` where `methods` includes the `__hostCallAction` bridge implementation scoped to the workflow's actions.

#### Scenario: One sandbox created per loaded workflow

- **GIVEN** two workflows `cronitor` and `notify` discovered at startup
- **WHEN** workflow loading completes
- **THEN** exactly two `Sandbox` instances SHALL exist, one per workflow
- **AND** each sandbox SHALL have the workflow's bundle evaluated

#### Scenario: __hostCallAction bound to workflow's manifest

- **GIVEN** a workflow with actions `a` and `b` in its manifest
- **WHEN** the sandbox is created
- **THEN** `__hostCallAction(name, input)` SHALL look up `name` in the workflow's manifest action list
- **AND** SHALL throw if `name` is not declared

### Requirement: Workflow loading resolves env at load time

The runtime SHALL apply the workflow's manifest `env` map to the loaded workflow object. The `env` resolution (reading `process.env`, applying defaults) happens at build time; the runtime simply reads the resolved values from the manifest.

#### Scenario: Env values match manifest

- **GIVEN** a manifest with `env: { URL: "https://..." }`
- **WHEN** the workflow is loaded
- **THEN** the workflow's `env.URL` (referenced by handlers as `workflow.env.URL`) SHALL equal `"https://..."`

## REMOVED Requirements

### Requirement: Per-action sandbox loading

**Reason**: Replaced by per-workflow sandbox loading. Each workflow loads once; actions and triggers within the workflow share the sandbox.

**Migration**: Adopt per-workflow loading; remove per-action sandbox creation logic.
