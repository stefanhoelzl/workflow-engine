## Why

The sandbox's `run(name, ctx, options)` API accepts an `extraMethods` field that installs per-run host methods, scoped to a single invocation. The surface exists for a historical use case — `emit(type, payload)` closing over the current event — which has since been replaced by a construction-time `__emitEvent` bridge plus `invocationId` threaded through `ctx`. After that migration, the only in-tree consumer of `extraMethods` is the WPT harness (`packages/sandbox/test/wpt/harness/runner.ts`), which passes `__wptReport` per run. But the WPT harness already constructs one fresh sandbox per test, so the per-run scoping is redundant — passing `__wptReport` via the construction-time `methods` argument yields identical behavior.

Keeping `extraMethods` costs real surface: a field on `RunOptions`, main-side merge + collision-detection logic, a worker-side per-run install/uninstall path for RPC-proxy globals, an `extraNames` field on the internal `run` MainToWorker message, and multiple scenarios across `sandbox/spec.md`, `wpt-compliance-harness/spec.md`, and `SECURITY.md`. The spec additionally references `extraMethods` in the `Isolation — no Node.js surface`, `__reportError host bridge`, `RunResult`, `LogEntry`, `Host-boundary JSON serialization`, and `Non-cloneable RPC arg` requirements. None of those references are load-bearing once the sole consumer migrates.

The spec is also drifted from code: the spec declares `run(name, ctx, extraMethods?)` while code has `run(name, ctx, options?: RunOptions)` with `RunOptions = { invocationId, workflow, workflowSha, extraMethods? }`. Removing `extraMethods` is the natural moment to realign the signature.

## What Changes

- **BREAKING (internal-only):** `RunOptions.extraMethods` is removed. The `Sandbox.run` signature becomes `run(name, ctx, options: RunOptions)` where `RunOptions = { invocationId, workflow, workflowSha }`.
- **BREAKING (internal-only):** the `run` MainToWorker message type drops its `extraNames` field. All host methods the guest can call SHALL be registered at construction time only.
- **WPT harness migration:** `packages/sandbox/test/wpt/harness/runner.ts` passes `{ __wptReport }` as the construction-time `methods` argument to `sandbox(source, methods, options)`. The closure over `captured: SubtestResult[]` continues to work because each `runWpt` call builds a dedicated sandbox.
- **Worker simplification:** `handleRun` no longer filters/installs/uninstalls per-run RPC-proxy globals. All methods the guest can call are installed once at init from the `methods` passed to `sandbox(...)`.
- **Spec realignment:** `openspec/specs/sandbox/spec.md` drops three `extraMethods` scenarios (`extend`, `shadowing rejected`, `cleared between runs`), rewrites the `Concurrent requestId correlation` scenario to exercise a construction-time method, and aligns the `run()` signature block with the real `RunOptions` shape from code. References to `extraMethods` in `Isolation — no Node.js surface`, `__reportError host bridge`, `RunResult`, `LogEntry`, `Host-boundary JSON serialization`, and the `Non-cloneable RPC arg` scenario are dropped.
- **WPT spec update:** `openspec/specs/wpt-compliance-harness/spec.md` — the `Harness never adds production sandbox surface` requirement is reframed: `__wptReport` is registered only via construction-time `methods` on the WPT harness's sandbox factory call; no production sandbox consumer constructs a sandbox with `__wptReport` in `methods`.
- **SECURITY.md update:** §2 references to `extraMethods` (bridge-surface inventory, §3/§4 allusions) are dropped. `CLAUDE.md` security invariants remain untouched — none reference `extraMethods`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sandbox`: the `Public API — Sandbox.run()` requirement is rewritten to match the real `RunOptions` shape and drop the `extraMethods` paragraph and its three scenarios; the `requestId correlation` scenario is rewritten for a construction-time method. References to `extraMethods` in `Isolation — no Node.js surface`, `__reportError host bridge`, `RunResult`, `LogEntry`, `Host-boundary JSON serialization`, and `Non-cloneable RPC arg` are dropped.
- `wpt-compliance-harness`: the `Harness never adds production sandbox surface` requirement is reframed around construction-time `methods`.

## Impact

**Code affected:**

- `packages/sandbox/src/index.ts` — drop `extraMethods` from `RunOptions`; drop the merge (`allMethods = {...methods, ...extraMethods}`) and `extraNames` plumbing (lines ~304–306); drop collision detection that checks `extraMethods` against reserved globals and construction-time methods.
- `packages/sandbox/src/worker.ts` — drop the `extraNames` filter, `installRpcMethods(...)`, and `uninstallGlobals(...)` in `handleRun` (lines ~504–511, 547). All host methods are installed once at init from `msg.methodNames`.
- `packages/sandbox/src/messages.ts` (or wherever `MainToWorker.run` is defined) — drop `extraNames` from the `run` message type.
- `packages/sandbox/test/wpt/harness/runner.ts` — pass `{ __wptReport }` as `methods` to `sandbox(...)`; remove `extraMethods` from the `sb.run(...)` call.
- `packages/sandbox/test/wpt/README.md` — update the mention of `extraMethods: { __wptReport }` to describe construction-time registration.

**Specs affected:**

- `openspec/specs/sandbox/spec.md` — seven requirements modified (see delta).
- `openspec/specs/wpt-compliance-harness/spec.md` — one requirement modified (see delta).

**Docs affected:**

- `SECURITY.md` — §2 bridge-surface inventory drops `extraMethods` mentions; surrounding §3/§4 references are cleaned up.

**Tests affected:**

- No dedicated `extraMethods` unit tests exist in `packages/sandbox/src/sandbox.test.ts` or elsewhere under `packages/sandbox/test/`. The three `extraMethods` spec scenarios are currently unexercised at the unit level; removal touches spec text only. The `Non-cloneable RPC arg` scenario is reframed to use a construction-time method (equivalent property).

**No external API changes.** Workflow authors and SDK consumers are unaffected. The runtime scheduler at `packages/runtime/src/workflow-registry.ts:397` already calls `sb.run(exportName, payload, { invocationId, workflow, workflowSha })` with no `extraMethods` field — the production call site needs no change.

**Threat model delta:**

- No new risks. The production invariant "`__wptReport` is not reachable from production sandboxes" continues to hold: production's sandbox is constructed with an empty `methods` object in `workflow-registry.ts`; `__wptReport` is passed only by the WPT harness at construction time in its test-only sandbox instance.
- Residual: none.
- Closes: zero threats (this is a pure simplification). The surface being removed was never the root of an open threat; its removal tightens the host/guest contract only by reducing the number of code paths reasoned about in `SECURITY.md §2`.
