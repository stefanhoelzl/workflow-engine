## MODIFIED Requirements

### Requirement: Per-workflow bundle

The plugin SHALL emit one bundled JavaScript file per workflow source file (not per action). The bundle SHALL contain all action handlers, the trigger handler, and module-scoped constants/imports. The bundle SHALL be written to `<outDir>/<workflow-name>/<workflow-name>.js` (e.g., `dist/cronitor/cronitor.js`).

The bundle SHALL use Rollup output `format: "iife"`. The IIFE namespace name SHALL be a fixed constant (`IIFE_NAMESPACE`) exported from `@workflow-engine/core` and imported by both the plugin (as Rollup's `output.name`) and the sandbox (when reading exports). The namespace SHALL NOT be derived from the workflow name. Exports SHALL be accessible from the IIFE's namespace object on `globalThis[IIFE_NAMESPACE]`.

The bundle SHALL NOT include the `@workflow-engine/sandbox-globals` polyfill import. Web API globals (`URL`, `TextEncoder`, `Headers`, `crypto`, `atob`, `btoa`, `structuredClone`, `fetch`, `Blob`, `AbortController`, `ReadableStream`) SHALL be provided by the sandbox's WASM extensions and host bridges, not by polyfills bundled into the workflow code.

#### Scenario: One IIFE bundle per workflow

- **GIVEN** a workflow file `cronitor.ts` declaring two actions and one trigger
- **WHEN** the plugin builds
- **THEN** the plugin SHALL emit exactly one workflow bundle: `dist/cronitor/cronitor.js`
- **AND** the bundle SHALL be an IIFE that assigns exports to `globalThis[IIFE_NAMESPACE]`

#### Scenario: Namespace is the shared constant, not derived from workflow name

- **GIVEN** two workflow files `cronitor.ts` and `demo.ts`
- **WHEN** the plugin builds each
- **THEN** both bundles SHALL assign their exports to the same namespace identifier (the value of `IIFE_NAMESPACE` from `@workflow-engine/core`)
- **AND** neither bundle SHALL use a workflow-name-derived namespace such as `__wf_cronitor` or `__wf_demo`

#### Scenario: Bundle does not contain polyfills

- **GIVEN** a workflow file that previously relied on `@workflow-engine/sandbox-globals`
- **WHEN** the plugin builds
- **THEN** the bundle SHALL NOT contain `whatwg-fetch`, `blob-polyfill`, `mock-xmlhttprequest`, or any sandbox-globals polyfill code
- **AND** the bundle SHALL NOT contain an `import` statement for `@workflow-engine/sandbox-globals`

#### Scenario: Bundle contains module-scoped imports and constants

- **GIVEN** a workflow file with `import { format } from "date-fns"` and `const BASE = "..."` at module scope
- **WHEN** the plugin builds
- **THEN** the bundle SHALL inline the `format` import and preserve `BASE` as a scoped constant
- **AND** the SDK and Zod runtime code SHALL NOT be included in the bundle
