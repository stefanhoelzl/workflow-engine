## 1. Core constant

- [x] 1.1 Add `export const IIFE_NAMESPACE = "__wfe_exports__"` to `packages/core/src/index.ts`
- [x] 1.2 Delete the `iifeName(workflowName)` function and its `export { ..., iifeName, ... }` entry from `packages/core/src/index.ts`
- [x] 1.3 Delete the entire `describe("iifeName", ...)` block from `packages/core/src/index.test.ts`
- [x] 1.4 Run `pnpm --filter @workflow-engine/core test` to confirm no other core tests referenced `iifeName`

## 2. Vite plugin

- [x] 2.1 In `packages/sdk/src/plugin/index.ts`, replace `import { iifeName } from "@workflow-engine/core"` with `import { IIFE_NAMESPACE } from "@workflow-engine/core"`
- [x] 2.2 Delete the `bundleIifeName = iifeName(filestem)` computation; use `IIFE_NAMESPACE` directly where `bundleIifeName` was passed
- [x] 2.3 Change `runIifeInVmContext(source, iifeName, filestem)` to `runIifeInVmContext(source, filestem)`; inside the function, replace `sandboxGlobal[iifeName]` with `sandboxGlobal[IIFE_NAMESPACE]` and the error message to reference `IIFE_NAMESPACE`
- [x] 2.4 Update the Rollup output config so `output.name` is `IIFE_NAMESPACE` directly (no per-workflow computation)
- [x] 2.5 Update any plugin-internal callers that previously passed the derived name

## 3. Sandbox package

- [x] 3.1 In `packages/sandbox/src/protocol.ts`, remove the `iifeNamespace: string` field from the `init` message type
- [x] 3.2 In `packages/sandbox/src/index.ts`, delete the `iifeNamespace?: string` option from the `sandbox()` factory signature and JSDoc
- [x] 3.3 In `packages/sandbox/src/index.ts`, delete the `DEFAULT_IIFE_NAMESPACE` module-level constant and its re-export
- [x] 3.4 In `packages/sandbox/src/index.ts`, replace the `const iifeNamespace = options?.iifeNamespace ?? DEFAULT_IIFE_NAMESPACE` resolution with a direct `import { IIFE_NAMESPACE } from "@workflow-engine/core"` and use the constant in the `reserved` globals guard (`reserved.add(IIFE_NAMESPACE)` and the `name === IIFE_NAMESPACE` check)
- [x] 3.5 In `packages/sandbox/src/index.ts`, stop forwarding `iifeNamespace` into the `init` message payload sent to the worker
- [x] 3.6 In `packages/sandbox/src/worker.ts`, remove the `iifeNamespace: string` field from the parsed init message schema and from worker state
- [x] 3.7 In `packages/sandbox/src/worker.ts`, import `IIFE_NAMESPACE` from `@workflow-engine/core` and use it at both call sites (`vm.global.getProp(...)` and the export-read helper)
- [x] 3.8 Change the `readExportFromIife(vm, iifeNamespace, exportName)` helper to `readExportFromIife(vm, exportName)`, reading the namespace from `IIFE_NAMESPACE` internally
- [x] 3.9 Update the "export not found" error message at the former `worker.ts:456` location to `` `export '${exportName}' not found in workflow bundle` `` (no namespace identifier)

## 4. Runtime

- [x] 4.1 In `packages/runtime/src/workflow-registry.ts`, replace `import { iifeName, ... } from "@workflow-engine/core"` with `import { IIFE_NAMESPACE, ... } from "@workflow-engine/core"`
- [x] 4.2 Drop the `iifeNamespace` parameter from the trigger-shim generator; inline `IIFE_NAMESPACE` into the template literal (`${IIFE_NAMESPACE}.${triggerShimName(name)} = …`)
- [x] 4.3 Drop the `iifeNamespace` parameter from the action-name-binder generator; inline `IIFE_NAMESPACE` into the template literals at the two call sites
- [x] 4.4 Delete the `const iifeNamespace = iifeName(manifest.name)` statements at both call sites (`:369` and `:411`), and remove them from the subsequent function-call argument lists
- [x] 4.5 Remove the `iifeNamespace` key from the options object forwarded into `sandboxFactory.create(...)` / `sandbox(...)` at `:419`

## 5. Test helpers

- [x] 5.1 In `packages/sandbox/src/factory.test.ts`, change the fake-IIFE template string from `var __workflowExports = ...` to `var __wfe_exports__ = ...`
- [x] 5.2 In `packages/sandbox/src/sandbox.test.ts`, apply the same rename in the fake-IIFE helper and the surrounding comment
- [x] 5.3 In `packages/sandbox/src/host-call-action.test.ts`, apply the same rename in the fake-IIFE helper
- [x] 5.4 In `packages/runtime/src/workflow-registry.test.ts`, change `var __wf_demo = ...` to `var __wfe_exports__ = ...` and update the surrounding comment that references `toIifeNamespace("demo")`
- [x] 5.5 In `packages/runtime/src/integration.test.ts`, apply the same rename and comment update
- [x] 5.6 Add a sandbox-boundary test: construct a sandbox from a bundle that lacks export `"missing"`, call `sb.run("missing", {})`, and assert that `RunResult.error.message` contains `"missing"` but does NOT contain `"__wfe_exports__"`, `"__wf_"`, or `"__workflowExports"` (covers the security-relevant requirement that error messages do not leak the namespace identifier)

## 6. Documentation

- [x] 6.1 Update `SECURITY.md` §2 wording that describes the IIFE evaluation model: replace the per-workflow-derived `iifeNamespace` reference with the fixed `IIFE_NAMESPACE` constant. Do not alter the threat-model assertions themselves — only the naming narrative.
- [x] 6.2 Grep for any other live (non-archived) documentation that references `iifeName`, `__wf_`, or `__workflowExports` and update

## 7. Validation

- [x] 7.1 Run `pnpm validate` (lint + typecheck + test across the workspace) and confirm it passes
- [x] 7.2 Run `pnpm build` and confirm a workflow bundles cleanly
- [x] 7.3 Run `pnpm start` and exercise a webhook trigger end-to-end to confirm the runtime ↔ sandbox handshake works with the new fixed namespace (covered by `packages/runtime/src/integration.test.ts`, which exercises the full manifest → registry → sandbox → trigger path with an IIFE bundle using the new fixed namespace; `pnpm start` is not a defined script in this repo)
- [x] 7.4 Grep the workspace (excluding `openspec/changes/archive/`, `node_modules/`, and `dist/`) for the literal strings `iifeName`, `iifeNamespace`, `__wf_`, `__workflowExports`, `DEFAULT_IIFE_NAMESPACE`; confirm zero matches outside explicit transition artifacts
- [x] 7.5 Run `pnpm exec openspec validate simplify-iife-namespace --strict` and confirm the change is valid
