# Workflow Loading Specification

## Purpose

Load workflow manifests + per-workflow bundles from storage and expose them to the executor via the WorkflowRegistry with one sandbox per workflow.
## Requirements
### Requirement: Workflow loading instantiates one sandbox per workflow

Workflow loading SHALL instantiate exactly one cached sandbox per `(tenant, sha)` via the SandboxStore. The sandbox source SHALL be the workflow bundle produced by the vite plugin without any runtime-side source appending. The runtime SHALL NOT concatenate `action-dispatcher.js` or any other dispatcher shim to the source before passing it to `sandbox({ source, plugins })`. The dispatcher logic lives in `createSdkSupportPlugin` (SDK package), which the runtime composes into the plugin list.

After sandbox initialization completes, the plugin-installed globals SHALL be present on `globalThis` per their `public: true` descriptors (fetch, setTimeout, console.*, etc.). The `__sdk` global SHALL be present (locked, frozen) for action dispatch. Private bindings (`__sdkDispatchAction`, `__reportErrorHost`, `$fetch/do`, `__wptReport` in tests) SHALL have been auto-deleted by the sandbox after phase 2.

User source — including SDK-bundled `action()` callables — SHALL run in phase 4 and see only the public globals and `__sdk`. The SDK's `action()` callable invokes `globalThis.__sdk.dispatchAction(name, input, handler, completer)`, which routes through the sdk-support plugin's host handler.

#### Scenario: No source appending

- **GIVEN** a tenant workflow bundle loaded by the runtime
- **WHEN** the runtime constructs the sandbox
- **THEN** `sandbox({ source: <bundle>, plugins: [...] })` SHALL be invoked with `source` exactly equal to the bundled workflow source
- **AND** no runtime source SHALL be concatenated, prepended, or appended

#### Scenario: Tenant bundles require re-upload post-deploy

- **GIVEN** a pre-existing tenant bundle produced by an older SDK (that called `globalThis.__dispatchAction`)
- **WHEN** loaded by the new runtime
- **THEN** the bundle SHALL fail because `globalThis.__dispatchAction` no longer exists
- **AND** operators SHALL re-upload every tenant via `wfe upload --tenant <name>`
- **AND** newly-built bundles SHALL call `globalThis.__sdk.dispatchAction` and succeed

#### Scenario: Private bindings invisible in phase 4

- **GIVEN** a sandbox post-init for any tenant workflow
- **WHEN** user source evaluates any of `typeof __sdkDispatchAction, typeof __reportErrorHost, typeof $fetch/do`
- **THEN** each SHALL be `"undefined"`
- **AND** `typeof __sdk` SHALL be `"object"`
- **AND** `typeof fetch, typeof setTimeout, typeof console` SHALL all be `"function"` (or `"object"` for console)

### Requirement: Workflow loading resolves env at load time

The runtime SHALL apply the workflow's manifest `env` map to the loaded workflow object. The `env` resolution (reading `process.env`, applying defaults) happens at build time; the runtime simply reads the resolved values from the manifest.

#### Scenario: Env values match manifest

- **GIVEN** a manifest with `env: { URL: "https://..." }`
- **WHEN** the workflow is loaded
- **THEN** the workflow's `env.URL` (referenced by handlers as `workflow.env.URL`) SHALL equal `"https://..."`

