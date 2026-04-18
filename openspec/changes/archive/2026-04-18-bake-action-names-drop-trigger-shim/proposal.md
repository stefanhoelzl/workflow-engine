## Why

The runtime currently injects two pieces of generated source into every workflow bundle at sandbox-load time: a `__trigger_<name>` shim per trigger (because `httpTrigger()` returns a non-callable object that the sandbox's `Sandbox.run(exportName, ...)` cannot invoke directly) and a per-action `__setActionName(...)` binder (because the SDK's `action()` callable starts unnamed and the bundle re-evaluates inside QuickJS with a fresh closure). Both exist because of asymmetries between the two SDK primitives — `action()` returns a callable, `httpTrigger()` returns an object; `action()` is naming-agnostic at construction, `httpTrigger()` doesn't need naming at all. Both impose a runtime code-generation step on the registry and a guest-observable side-channel on each action callable (`__setActionName`) that the runtime then has to delete defensively.

Also: today the public `Action` interface exposes `.handler` directly on the callable, which lets guest code call `myAction.handler(input)` to bypass the dispatcher and the host's `__hostCallAction` audit log. That bypass is documented as an accepted residual but is closeable for free as part of this cleanup.

## What Changes

- **BREAKING (SDK surface)**: `httpTrigger({...})` now returns a callable. `await myTrigger(payload)` invokes the user's handler. The `.handler` property is removed from the public `HttpTrigger` interface (`HTTP_TRIGGER_BRAND`, `path`, `method`, `body`, `params`, `query`, `schema` remain).
- **BREAKING (SDK surface)**: `action({input, output, handler})` becomes `action({input, output, handler, name})` — `name` is required. The `.handler` property and the `__setActionName` slot are removed from the public `Action` interface. Calling `action({...})` without `name` throws on first invocation with a message pointing at the vite-plugin or explicit `name`.
- **BREAKING (vite-plugin)**: the plugin AST-transforms each `export const X = action({...})` declaration to inject `name: "X"` into the call expression at build time. Only `export const X = action({...})` at module scope is supported; other patterns (`const X = action({...}); export { X };`, `export default action({...})`, `const X = isProd ? action({...}) : ...`, computed exports) fail the build with a clear message.
- **BREAKING (vite-plugin)**: aliased action exports (`export const X = action({...}); export { X as Y };`) detected during the existing manifest-building export walk by callable-identity check; build fails with the same `ERR_ACTION_MULTI_NAME` message used today.
- **BREAKING (runtime internals)**: `TRIGGER_SHIM_PREFIX`, `triggerShimName`, `buildTriggerShim`, `buildActionNameBinder` are deleted from `packages/runtime/src/workflow-registry.ts`. `buildSandboxSource` collapses to `${bundleSource}\n${ACTION_DISPATCHER_SOURCE}`. `buildInvokeHandler` calls `sb.run(triggerName, ...)` with the user's export name (no shim-prefix translation).
- SECURITY.md §2 ASCII diagram at L85 updated; the `__setActionName` and `__trigger_*` references in §6 invariants removed; the action-bypass-via-`.handler` residual removed from the threats table.

## Capabilities

### New Capabilities

None. All changes modify existing specs.

### Modified Capabilities

- `sdk`: the `httpTrigger factory creates branded HttpTrigger` requirement adds the callable contract and removes `.handler` from the public surface. The `action factory returns typed callable` requirement adds the required `name` config field, removes `.handler` and `__setActionName` from the public surface, and rewrites the dispatcher-indirection prose to match the new flow.
- `vite-plugin`: the `Action call resolution at build time` requirement is rewritten — the plugin AST-transforms `action({...})` calls to inject `name`, replacing the runtime-binder-shim mechanism. A new requirement (`Workflow author declaration constraints`) codifies the supported declaration form. The `Brand-symbol export discovery` requirement adds an alias-detection scenario.
- `workflow-loading`: the requirement that the runtime appends a name-binder shim to the bundle is removed; only the dispatcher-shim append remains.
- `http-trigger`: the `httpTrigger factory creates branded HttpTrigger` requirement is updated to describe the callable contract.

## Impact

**Code affected:**

- `packages/sdk/src/index.ts` — `HttpTrigger` interface adds callable signature, drops `.handler`; `httpTrigger()` returns a callable wrapping `config.handler`. `Action` interface drops `.handler` and `__setActionName`; `action()` requires `name` in config; the captured `handler` reference is closed over the callable as today.
- `packages/sdk/src/plugin/index.ts` — new AST-transform step in the plugin's `transform` hook for workflow source files using Rollup's bundled acorn parser; `discoverExports`/`buildActionEntries` updated to drop the build-time `__setActionName(exportName)` call (no longer needed); `buildTriggerEntry` swaps the `typeof trigger.handler !== "function"` check for `typeof trigger !== "function"`.
- `packages/runtime/src/workflow-registry.ts` — delete `TRIGGER_SHIM_PREFIX`, `triggerShimName`, `buildTriggerShim`, `buildActionNameBinder`; `buildSandboxSource` collapses; `buildInvokeHandler` uses the trigger's export name directly.
- `packages/sdk/src/index.test.ts` — the two `.handler === handler` assertions reframed as callable-equivalence assertions; new tests for the missing-name error and the new declaration-constraint failures.
- `packages/sdk/src/plugin/workflow-build.test.ts` — `ACTION_TWO_NAMES` fixture stays (alias detection moves but still fails the build); new fixtures for unsupported declaration patterns; the `ERR_ACTION_MULTI_NAME` constant may be supplemented with `ERR_ACTION_DECL_FORM`.

**Specs affected:**

- `openspec/specs/sdk/spec.md` — two requirements modified (httpTrigger factory, action factory).
- `openspec/specs/vite-plugin/spec.md` — one requirement modified (Action call resolution at build time); one requirement added (Workflow author declaration constraints); one scenario added under Brand-symbol export discovery.
- `openspec/specs/workflow-loading/spec.md` — one requirement modified (drop name-binder shim, keep dispatcher shim).
- `openspec/specs/http-trigger/spec.md` — one requirement modified (httpTrigger factory creates branded HttpTrigger).

**Docs affected:**

- `SECURITY.md` §2 — ASCII diagram at L85 updated; the action-bypass-via-`.handler` residual removed from the threats narrative.
- `SECURITY.md` §6 / `CLAUDE.md` "Security Invariants" — drop the `__setActionName`-after-binder-runs reference (no longer applicable).

**Threat model delta:**

- Closes: `myAction.handler(input)` bypass channel — guest code can no longer call the raw handler bypassing `dispatchAction`.
- Closes: guest-side overwrite of `__setActionName` (the slot is gone entirely).
- Net SDK surface area shrinks; no new bridges introduced.

**Author migration:**

- Workflow files that already use the conventional `export const X = action({...})` pattern need no changes — the plugin handles `name` injection transparently.
- Workflow files using detached exports (`const X = action({...}); export { X };`) or default exports must convert to `export const X = action({...})`. A grep across the repo confirms zero such usages today (only `BASIC_WORKFLOW`-shaped and `ACTION_TWO_NAMES`-shaped fixtures exist).
- Workflow files reading `myAction.handler` or `myTrigger.handler` directly stop compiling — the property is removed from the type. None observed in current workflows.
