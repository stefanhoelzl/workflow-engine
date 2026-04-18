## MODIFIED Requirements

### Requirement: Workflow loading instantiates one sandbox per workflow

The runtime SHALL load each tenant's workflows by reading the tenant tarball from the storage backend at `workflows/<tenant>.tar.gz`, parsing the root `manifest.json`, and for each workflow entry instantiating exactly one `Sandbox` with the bundle source named by `workflow.module`. The sandbox SHALL be created via `sandbox(source, methods)` where `methods` includes the `__hostCallAction` bridge implementation scoped to the workflow's actions.

#### Scenario: One sandbox created per loaded workflow across all tenants

- **GIVEN** tenant "acme" with workflows `cronitor` and `notify`, and tenant "stefan" with workflow `scratch`
- **WHEN** workflow loading completes
- **THEN** exactly three `Sandbox` instances SHALL exist, one per workflow per tenant
- **AND** each sandbox SHALL have the workflow's bundle evaluated
- **AND** the registry SHALL contain keys `(acme, cronitor)`, `(acme, notify)`, `(stefan, scratch)`

#### Scenario: __hostCallAction bound to workflow's manifest

- **GIVEN** a workflow with actions `a` and `b` in its tenant manifest entry
- **WHEN** the sandbox is created
- **THEN** `__hostCallAction(name, input)` SHALL look up `name` in the workflow's action list
- **AND** SHALL throw if `name` is not declared

### Requirement: Workflow loading resolves env at load time

The runtime SHALL apply the workflow's manifest-entry `env` map to the loaded workflow object. The `env` resolution (reading `process.env`, applying defaults) happens at build time; the runtime simply reads the resolved values from the manifest.

#### Scenario: Env values match manifest

- **GIVEN** a workflow manifest entry with `env: { URL: "https://..." }`
- **WHEN** the workflow is loaded
- **THEN** the workflow's `env.URL` (referenced by handlers as `workflow.env.URL`) SHALL equal `"https://..."`

## ADDED Requirements

### Requirement: Workflow loading bootstraps from storage backend

At startup, the runtime SHALL LIST all keys matching `workflows/*.tar.gz` on the storage backend. For each matched key, the runtime SHALL read the tarball, parse its root `manifest.json`, and load every workflow entry into the registry keyed by `(tenant, name)` where `tenant` is the filename stem (the portion between `workflows/` and `.tar.gz`).

The runtime SHALL NOT consult any filesystem directory (e.g. a legacy `WORKFLOW_DIR` / `WORKFLOWS_DIR` environment variable) for workflow bootstrap. If such a variable is set, the runtime SHALL emit a `warn`-level log on startup identifying it as ignored.

#### Scenario: Bootstrap loads all tenant tarballs

- **GIVEN** the storage backend contains `workflows/acme.tar.gz` and `workflows/stefan-hoelzl.tar.gz`
- **WHEN** the runtime starts
- **THEN** every workflow declared in `acme.tar.gz`'s manifest SHALL be registered under tenant `"acme"`
- **AND** every workflow declared in `stefan-hoelzl.tar.gz`'s manifest SHALL be registered under tenant `"stefan-hoelzl"`

#### Scenario: Empty storage boots to empty registry

- **GIVEN** the storage backend contains no keys under `workflows/`
- **WHEN** the runtime starts
- **THEN** the registry SHALL be empty
- **AND** the runtime SHALL continue to serve HTTP requests (with 404 for all trigger paths) until a first upload

#### Scenario: Legacy WORKFLOW_DIR is ignored with a warning

- **GIVEN** the environment contains `WORKFLOW_DIR=/workflows` or `WORKFLOWS_DIR=/workflows`
- **WHEN** the runtime starts
- **THEN** the runtime SHALL emit a `warn` log identifying the env var and stating that workflow bootstrap is now storage-backend only
- **AND** the directory SHALL NOT be scanned

#### Scenario: Invalid tenant tarball skipped with logged error

- **GIVEN** the storage backend contains `workflows/broken.tar.gz` that fails to gunzip/untar or whose manifest fails `ManifestSchema`
- **WHEN** the runtime starts
- **THEN** the tenant SHALL be skipped
- **AND** an `error`-level log SHALL identify the tenant and the failure reason
- **AND** other tenants SHALL be loaded normally
