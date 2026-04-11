## MODIFIED Requirements

### Requirement: Transform hook produces default exports

The plugin SHALL transform each workflow into a standalone ES module by running a secondary `vite.build()` with a stub SDK plugin and a sandbox-globals plugin. The stub SHALL replace `@workflow-engine/sdk` so that `workflow.action({ handler })` returns `handler` directly. The sandbox-globals plugin SHALL resolve `@workflow-engine/sandbox-globals` to a virtual module that sets up Web API polyfills on `globalThis`, and SHALL inject `import "@workflow-engine/sandbox-globals"` at the top of the workflow entry via a `transform` hook. The secondary build SHALL use `build.ssr: true`, `ssr.noExternal: true`, `enforce: 'pre'` on both plugins, and `rollupOptions.input` pointing to the original workflow `.ts` file.

#### Scenario: Handler preserved as named export with npm imports and polyfills bundled

- **WHEN** a handler imports `format` from `date-fns` and calls it
- **THEN** the output module SHALL contain the `format` function bundled inline
- **AND** the handler's named export SHALL be callable with the same behavior
- **AND** the output module SHALL contain polyfill setup code for globals used by `date-fns`

#### Scenario: Module-level imports preserved

- **WHEN** a handler references a module-level import (e.g., `import { format } from "date-fns"`)
- **THEN** the import SHALL be resolved and bundled into the output module
- **AND** the handler's reference to `format` SHALL remain valid

#### Scenario: Module-level constants preserved

- **WHEN** a handler references a module-level constant (e.g., `const BASE_URL = "..."`)
- **THEN** the constant SHALL be preserved in the output module

#### Scenario: Polyfill virtual module is resolved

- **WHEN** the secondary build encounters `import "@workflow-engine/sandbox-globals"`
- **THEN** the sandbox-globals plugin SHALL resolve it to the virtual module ID `"\0sandbox-globals"`
- **AND** the virtual module source SHALL be loaded and bundled into the output

#### Scenario: Polyfill import is injected into workflow entry

- **WHEN** the secondary build transforms the workflow `.ts` file
- **THEN** `import "@workflow-engine/sandbox-globals"` SHALL be prepended to the source
- **AND** the polyfill setup code SHALL execute before any action handler code
