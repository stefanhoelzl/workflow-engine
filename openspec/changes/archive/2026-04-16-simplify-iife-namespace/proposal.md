## Why

The IIFE bundle namespace (the global name the Rollup-produced script assigns exports to) is currently derived per-workflow from the workflow name via `iifeName()` in `@workflow-engine/core`. Each sandbox worker, however, evaluates exactly one workflow in an isolated QuickJS VM, so the derived-per-workflow naming serves no purpose. The name is threaded through eight coupling points — core's `iifeName()` helper, the vite-plugin's bundler config and Node VM eval, the runtime's trigger shim and action-name binder generators, the sandbox factory's public option, the worker's init message schema, and the worker's runtime read path — purely to carry a value that will always be unique by construction. Collapsing this to a single shared constant removes threading, deletes a pointless name-sanitization helper with ten-plus tests, and eliminates two parallel conventions already in the codebase (`__wf_<camel>` from runtime overrides vs. the sandbox's internal `__workflowExports` default).

## What Changes

- Introduce `IIFE_NAMESPACE = "__wfe_exports__"` as a shared constant exported from `@workflow-engine/core`.
- **BREAKING (internal):** Delete the `iifeName(workflowName)` function and all its tests from `@workflow-engine/core`. No public SDK caller exists; it is only used by the plugin and runtime, which both switch to the constant.
- **BREAKING (internal):** Remove the `iifeNamespace` field from the sandbox worker's `init` message (`packages/sandbox/src/protocol.ts`). The worker imports the constant directly.
- **BREAKING (internal):** Remove the `iifeNamespace?: string` option from the `sandbox()` factory (`packages/sandbox/src/index.ts`) and delete the `DEFAULT_IIFE_NAMESPACE` local constant. The factory hardcodes the shared constant for the `reserved` globals guard.
- **BREAKING (internal):** Drop the `iifeName` parameter from `runIifeInVmContext()` in the vite-plugin and the `iifeNamespace` parameter from the runtime's trigger-shim and action-name-binder generators.
- Update the sandbox's "export not found" error message at `packages/sandbox/src/worker.ts:456` to drop the namespace identifier — the workflow identity is already present in log context and stack frames.
- Update test helpers in five files that fabricate fake IIFE bundles (`packages/sandbox/src/factory.test.ts`, `sandbox.test.ts`, `host-call-action.test.ts`, `packages/runtime/src/workflow-registry.test.ts`, `integration.test.ts`) to use the new constant.
- Update `SECURITY.md` §2 wording that references a per-workflow-derived `iifeNamespace`; the evaluation model itself is unchanged.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `vite-plugin`: The IIFE bundle's `name` (Rollup `output.name`) is now a fixed constant imported from `@workflow-engine/core` rather than derived from the workflow filename.
- `sandbox`: The worker resolves the IIFE namespace from the shared constant. The `iifeNamespace` init-message field and the `sandbox()` factory's `iifeNamespace` option are removed. Error messages referring to the namespace identifier are simplified.

## Impact

- **Code touched:** `packages/core/src/index.ts` (+constant, −`iifeName`), `packages/core/src/index.test.ts` (−`iifeName` test block), `packages/sdk/src/plugin/index.ts` (−parameter, uses constant), `packages/runtime/src/workflow-registry.ts` (−parameter threading, uses constant), `packages/sandbox/src/index.ts` (−option, −`DEFAULT_IIFE_NAMESPACE`), `packages/sandbox/src/protocol.ts` (−field), `packages/sandbox/src/worker.ts` (−parameter, reworded error), plus five test helper files and `SECURITY.md`.
- **Wire protocol:** The sandbox worker `init` message loses the `iifeNamespace` field. Sandbox and runtime are versioned together (same pnpm workspace, always deployed as a unit), so no compatibility window is required.
- **Public API surface:** None. The SDK does not re-export `iifeName`, the `sandbox()` option is documented only in source, and user-authored workflows never observe the namespace name.
- **Manifest format:** Unchanged. The manifest never stored the namespace; it was derived at runtime from `manifest.name`.
- **EventBus / consumer pipeline:** Unaffected.
- **Security boundary:** Neutral-to-positive. The `reserved` globals guard continues to prevent user code from shadowing the namespace; with a fixed name the rule becomes uniform and greppable rather than dynamic.
