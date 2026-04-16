## MODIFIED Requirements

### Requirement: Source evaluated as IIFE script

The sandbox SHALL evaluate `source` as a script (not an ES module) using `vm.evalCode(source, filename)`. The source SHALL be an IIFE bundle produced by the vite-plugin with `format: "iife"`. Named exports SHALL be accessible from the IIFE's global namespace object via `vm.getProp(vm.global, IIFE_NAMESPACE)`, where `IIFE_NAMESPACE` is the shared constant exported from `@workflow-engine/core`. The sandbox SHALL NOT accept the namespace as a parameter, option, or worker-message field — it is a compile-time constant imported directly by the sandbox implementation.

When a `run(name, ctx)` call names an export that is not present on the IIFE namespace object, the sandbox SHALL resolve with a `RunResult` of shape `{ ok: false, error: { message, stack }, logs }` whose `message` identifies the missing export by its requested name and does NOT include the namespace identifier. Example: `export 'handler' not found in workflow bundle`.

#### Scenario: Named export handler

- **GIVEN** a source bundled as an IIFE that exposes `handler` on its namespace object
- **WHEN** `sb.run("handler", ctx)` is called
- **THEN** the `handler` function SHALL be extracted from the namespace and called

#### Scenario: Bundled IIFE with dependencies

- **GIVEN** a workflow bundle that includes npm packages resolved by vite-plugin, output as IIFE
- **WHEN** the sandbox evaluates the bundled script
- **THEN** evaluation SHALL succeed and named exports SHALL be callable

#### Scenario: Missing export error message omits namespace identifier

- **GIVEN** a sandbox whose bundle does not export `"missing"`
- **WHEN** `sb.run("missing", {})` is called
- **THEN** the returned `RunResult.error.message` SHALL name `"missing"` as the requested export
- **AND** the message SHALL NOT include the literal namespace identifier (e.g. no `__wfe_exports__`, no `__wf_*`, no `__workflowExports`)
