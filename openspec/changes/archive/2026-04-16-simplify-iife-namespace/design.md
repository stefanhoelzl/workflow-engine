## Context

Workflow source, after the vite-plugin bundles it, is an IIFE of the shape:

```js
var <name> = (function (exports) { /* ... */ return exports; })({});
```

The sandbox worker reads its exports by looking up `globalThis[<name>]` inside a fresh QuickJS VM. The SDK's Node-side plugin does the same against a Node `vm.createContext()` during build-time manifest extraction. The runtime's `workflow-registry` concatenates shim source that references `<name>.onEvent.handler(...)` and `<name>.myAction.__setActionName(...)`.

`<name>` today is derived per-workflow via `iifeName(manifest.name)` in `@workflow-engine/core`, which camelCases the workflow name and prepends `__wf_`. The value is:

1. Computed in the plugin from the bundle filestem (`plugin/index.ts:171`), passed to Rollup as `output.name` (`plugin/index.ts:495`), and used to read the namespace back from the Node VM after eval (`plugin/index.ts:234`).
2. Recomputed in the runtime from the manifest name (`workflow-registry.ts:369`, `:411`), used to template shim source (`:227`, `:247`), and passed into the sandbox factory (`:419`).
3. Received by the worker as an init-message field (`protocol.ts:27`, `worker.ts:195`, `:305`), stored on worker state, and used both for export reads (`worker.ts:362`, `:448`) and in an error message (`worker.ts:456`).
4. Accepted as an optional `sandbox()` option (`sandbox/index.ts:42`) with a default (`DEFAULT_IIFE_NAMESPACE = "__workflowExports"`, `sandbox/index.ts:67`) and used by the factory's `reserved` globals guard (`sandbox/index.ts:173, :178`).

The derivation is structurally unnecessary: **each sandbox worker evaluates exactly one workflow in an isolated VM** (verified: `handleInit()` creates one VM, stores it on process-lifetime state, never reloads; `runIifeInVmContext` creates a fresh Node context per invocation and discards it). The per-workflow name was only meaningful back when the sandbox allowed multiple distinct namespaces in the same scope — a capability nothing uses.

Two different conventions already exist: the sandbox's internal default `__workflowExports` and the runtime's override `__wf_<camel>`. Every real invocation goes through the runtime path, so the sandbox default is dead-by-practice.

## Goals / Non-Goals

**Goals:**

- Replace all per-workflow namespace derivation with a single, shared constant imported from `@workflow-engine/core`.
- Delete the `iifeName()` function and its test block.
- Remove `iifeNamespace` from every internal function signature, message schema, and factory option it currently appears in.
- Keep the IIFE evaluation model — same Rollup `format: "iife"`, same `vm.evalCode(source, filename)` script-mode evaluation, same `globalThis[name]` export-read pattern.
- Make error messages at the sandbox boundary self-contained without resurrecting namespace threading.

**Non-Goals:**

- Migrating to ES module output. Blocked upstream: `quickjs-wasi` supports `EvalFlags.TYPE_MODULE` and a `moduleLoader`, but does not expose `JS_GetModuleNamespace` or any post-eval export-retrieval API. Revisit only if upstream gains this surface.
- Changing the manifest schema. The manifest never stored the namespace (it was always derived from `manifest.name` at runtime), so nothing to drop.
- Changing stack-trace filenames, log prefixes, or worker-process identifiers — those still use the workflow name and remain useful for debugging.

## Decisions

### D1: Fixed namespace, shared constant

Export `IIFE_NAMESPACE = "__wfe_exports__"` from `@workflow-engine/core`. All three consumers (plugin, runtime, sandbox) import it.

**Alternatives considered:**

- *Duplicate string literal in each consumer.* Zero cross-package coupling, but the bundler output and worker read must agree on the exact string — a drift here fails silently at runtime. Shared constant makes drift impossible.
- *Keep per-workflow derivation.* Status quo. Adds no value (one workflow per VM) and costs eight threading points.
- *Migrate to ES modules.* Blocked by `quickjs-wasi` as noted in Non-Goals.

The chosen name `__wfe_exports__` (workflow-engine exports) is distinct from both `__wf_*` and `__workflowExports` so any legacy reference becomes a loud test failure rather than silently picking up the new path. The double-underscore bracketing follows the project's convention for host-reserved identifiers (`__hostFetch`, `__setActionName`, `__trigger_*`, `__dispatchAction`).

### D2: Remove `iifeNamespace` from the worker init message

The sandbox and runtime are versioned together in the same pnpm workspace and always deployed as a unit. There is no compatibility window and no external worker implementation to preserve. The init message loses the field entirely; the worker imports the constant directly from core.

**Alternatives considered:**

- *Keep the field, always set to the constant.* Preserves a hook for hypothetical multi-namespace futures. Costs schema noise and implies variability that does not exist. Rejected.

### D3: Remove the `sandbox()` factory option and `DEFAULT_IIFE_NAMESPACE`

The public `iifeNamespace?: string` option on the factory, and the module-level `DEFAULT_IIFE_NAMESPACE` constant behind it, both exist to parameterise a value that is now fixed. Both are removed. The `reserved` globals guard in `sandbox/index.ts:173, :178` references the imported constant directly.

### D4: Drop `iifeName` parameter from `runIifeInVmContext`

The SDK plugin's `runIifeInVmContext(source, iifeName, filestem)` (`plugin/index.ts:213`) becomes `runIifeInVmContext(source, filestem)`. It imports the constant and uses it internally. The `filestem` argument remains — it is purely a label for error messages about the specific workflow file being bundled.

### D5: Drop `iifeNamespace` parameter from runtime shim generators

The trigger-shim and action-name-binder generators in `packages/runtime/src/workflow-registry.ts` (`:221`, `:241`) drop their `iifeNamespace` parameter and inline the imported constant in their template literals. Call sites at `:369`, `:411` also drop the derivation step.

### D6: Simplify the "export not found" error message

Current (`worker.ts:456`):

```
export '<name>' not found on IIFE namespace '<iifeNamespace>'
```

New:

```
export '<name>' not found in workflow bundle
```

Rationale: the namespace identifier was useful only when it encoded the workflow name. With a fixed constant it is boilerplate every error would carry. Workflow identity is already available to operators via log context (the sandbox worker is spawned per-workflow with a process title containing the workflow name) and via the `filename` argument passed to `vm.evalCode(source, filename)` which appears in stack frames.

**Alternatives considered:**

- *Include `manifest.name` in the error.* Would resurrect a form of threading — the worker would need to receive the workflow name via the init message purely for error-message formatting. Rejected: operators already have this via log/stack context.

### D7: Keep IIFE script-mode evaluation unchanged

No change to `vm.evalCode(source, filename)`, Rollup's `format: "iife"`, or the strict-mode-vs-script-mode semantics the project already documents (archived change `quickjs-wasi-migration`, D4). The only change at this layer is the value Rollup writes into `output.name`.

## Risks / Trade-offs

**[Silent regression from test helpers that hardcode old namespace strings] → Bulk replace, not per-test edits**

Five test files fabricate fake IIFE bundles using template strings like `var __workflowExports = (function(exports) {…})({});` and `var __wf_demo = (function(exports) {…})({});`. If any is missed, the test produces a valid IIFE the sandbox will not find, surfacing as `export 'handler' not found in workflow bundle` during test run. Mitigation: the task list explicitly enumerates all five files and the migration includes a post-change grep for both legacy prefixes (`__wf_`, `__workflowExports`) in the workspace excluding `openspec/changes/archive/`.

**[Loss of namespace identifier in error messages reduces debuggability] → Offset by existing context channels**

An operator who previously saw `IIFE namespace '__wf_myCoolWorkflow'` and `handler` missing could infer both the workflow and the missing export from a single error line. Post-change the line names only the export; the workflow is recovered from log prefix or `evalCode` filename. This is a mild information loss in exchange for removing a plumbing field — the alternative (threading `manifest.name` through the init message purely for errors) re-creates the coupling we are removing.

**[Forward compatibility with an eventual ES-module migration] → Neutral**

If `quickjs-wasi` later exposes module namespaces, the migration surface is the same either way: change Rollup output format, change the VM eval call, and change the export-read path. The fixed-constant simplification does not add or remove work for that future change. It does delete `iifeName()`, which that migration would also have deleted.

**[Legacy archived spec references to the derived-name model] → Leave archived docs untouched**

The archived `quickjs-wasi-migration` change under `openspec/changes/archive/` describes the "derived from workflow name" rule. Archived changes are historical artifacts and are not updated. The active specs under `openspec/specs/vite-plugin/` and `openspec/specs/sandbox/` get deltas.
