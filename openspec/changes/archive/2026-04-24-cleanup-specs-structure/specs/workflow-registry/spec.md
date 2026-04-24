## ADDED Requirements

### Requirement: Workflow loading instantiates one sandbox per `(tenant, sha)`

Workflow loading SHALL instantiate exactly one cached sandbox per `(tenant, sha)` via the SandboxStore (see `sandbox` "SandboxStore provides per-`(tenant, sha)` sandbox access"). The sandbox source SHALL be the workflow bundle produced by the vite plugin WITHOUT any runtime-side source appending. The runtime SHALL NOT concatenate `action-dispatcher.js` or any other dispatcher shim to the source before passing it to `sandbox({ source, plugins })`. Dispatcher logic lives in `createSdkSupportPlugin` (see `sdk` capability), which the runtime composes into the plugin list.

After sandbox initialization completes, the plugin-installed globals SHALL be present on `globalThis` per their descriptors' `public` flags: public descriptors (fetch, setTimeout, console.*) survive Phase 3; private descriptors (`__sdkDispatchAction`, `__reportErrorHost`, `$fetch/do`, `__wptReport` in tests) are auto-deleted by Phase 3 after being captured in Phase-2 IIFE closures. The `__sdk` global SHALL be present (locked, frozen) for action dispatch.

User source — including SDK-bundled `action()` callables — SHALL run in Phase 4 and SHALL see only the public globals, the VM-level globals from quickjs-wasi extensions, and `__sdk`. SDK `action()` callables invoke `globalThis.__sdk.dispatchAction(name, input, handler)`, which routes through the sdk-support plugin's host handler.

#### Scenario: No source appending

- **GIVEN** a tenant workflow bundle loaded by the runtime
- **WHEN** the runtime constructs the sandbox
- **THEN** `sandbox({ source: <bundle>, plugins: [...] })` SHALL be invoked with `source` exactly equal to the bundle
- **AND** no runtime source SHALL be concatenated, prepended, or appended

#### Scenario: Stale tenant bundles require re-upload

- **GIVEN** a pre-existing tenant bundle produced by an older SDK that called `globalThis.__dispatchAction`
- **WHEN** loaded by the new runtime
- **THEN** the bundle SHALL fail because `globalThis.__dispatchAction` no longer exists
- **AND** operators SHALL re-upload every tenant via `wfe upload --tenant <name>`
- **AND** newly-built bundles SHALL call `globalThis.__sdk.dispatchAction` and succeed

#### Scenario: Private bindings invisible in Phase 4

- **GIVEN** a sandbox post-init for any tenant workflow
- **WHEN** user source evaluates `typeof __sdkDispatchAction`, `typeof __reportErrorHost`, `typeof $fetch/do`
- **THEN** each SHALL be `"undefined"`
- **AND** `typeof __sdk` SHALL be `"object"`
- **AND** `typeof fetch`, `typeof setTimeout`, `typeof console` SHALL all be `"function"` (or `"object"` for console)

### Requirement: Manifest `env` resolution at build time

The runtime SHALL apply the workflow's manifest `env` map to the loaded workflow object. The `env` resolution (reading `process.env`, applying defaults) happens AT BUILD TIME inside the vite plugin; the runtime merely reads resolved values from the manifest. The runtime SHALL NOT re-read `process.env` at load time.

#### Scenario: env values match manifest

- **GIVEN** a manifest with `env: { URL: "https://..." }`
- **WHEN** the workflow is loaded
- **THEN** the workflow's `env.URL` (referenced by handlers as `workflow.env.URL`) SHALL equal `"https://..."`
