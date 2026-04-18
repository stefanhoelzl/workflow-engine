## 1. Sandbox package — public API

- [x] 1.1 In `packages/sandbox/src/index.ts`, remove `extraMethods?: MethodMap` from the `RunOptions` interface
- [x] 1.2 In `packages/sandbox/src/index.ts`, delete the per-run dispatch block at the top of `run()` that reads `runOptions.extraMethods`, builds `allMethods = {...methods, ...extraMethods}`, and computes `extraNames` (lines ~304–306 at time of drafting). The message handler SHALL dispatch `request` messages directly against `methods` for the life of the sandbox
- [x] 1.3 In `packages/sandbox/src/index.ts`, remove any collision-detection logic that compares `extraMethods` keys against `RESERVED_BUILTIN_GLOBALS` or construction-time `methods`. Collision detection at construction time (for `methods` alone, against `RESERVED_BUILTIN_GLOBALS`) SHALL remain
- [x] 1.4 Remove all references to `extraMethods` / `extraNames` from the `run` MainToWorker message type declaration (e.g., `packages/sandbox/src/messages.ts` or wherever the discriminated message types live) and update any type imports accordingly

## 2. Sandbox package — worker

- [x] 2.1 In `packages/sandbox/src/worker.ts` `handleRun`, delete the `constructionNames`/`extraNames` filter and the `installRpcMethods(bridge, bridge.vm.global, extraNames, sendRequest)` call (lines ~504–511)
- [x] 2.2 In `packages/sandbox/src/worker.ts` `handleRun` finally-block, delete the `uninstallGlobals(bridge, extraNames)` call (line ~547). All host globals are installed once at init and persist for the sandbox's lifetime
- [x] 2.3 Verify `installRpcMethods` and `uninstallGlobals` still have callers at init time; if not (purely per-run callers were removed), delete them — but preserve any init-time path for construction-time method installation
- [x] 2.4 Remove any worker-side tracking of "which globals were installed for this run" that becomes dead after 2.1/2.2

## 3. WPT harness — migrate to construction-time

- [x] 3.1 In `packages/sandbox/test/wpt/harness/runner.ts`, pass `{ __wptReport: async (...args) => { ... captured.push(...); } }` as the `methods` argument to `sandbox(source, methods, { memoryLimit: MEMORY_LIMIT })`. Keep the closure over the runner-local `captured` array; its lifetime matches the sandbox's
- [x] 3.2 In the same file, remove the `extraMethods: { __wptReport: ... }` block from the `sb.run(...)` options object; the `run()` call SHALL pass only `{ invocationId, workflow, workflowSha }`
- [x] 3.3 Verify the closure over `captured` still collects subtest results correctly (each `runWpt` call constructs its own sandbox, so each `captured` is written only by its own `__wptReport`; no cross-test leakage)
- [x] 3.4 In `packages/sandbox/test/wpt/README.md`, replace the "via `sandbox.run(..., { extraMethods: { __wptReport } })`" phrasing with a description of construction-time registration ("via the `methods` argument of the test-only `sandbox(...)` call")

## 4. Sandbox spec — deltas

- [x] 4.1 `openspec/specs/sandbox/spec.md` — MODIFIED `Public API — Sandbox.run()`: rewrite the method signature block to match real code (`run(name, ctx, options: RunOptions)` with `RunOptions = { invocationId, workflow, workflowSha }`); drop step 2 (main-side handler install for extraMethods), drop step 3's `extraMethods` wording, drop step 4's handler-scoping language, drop the trailing "per-run RPC handlers" paragraph; drop the three `extraMethods` scenarios (`extend`, `shadowing rejected`, `cleared between runs`); rewrite the `Concurrent requestId correlation` scenario to use a construction-time method
- [x] 4.2 `openspec/specs/sandbox/spec.md` — MODIFIED `RunResult discriminated union`: drop "invalid extraMethods collision" from the "MAY throw for host-side programming errors" example list; retain "sandbox already disposed"
- [x] 4.3 `openspec/specs/sandbox/spec.md` — MODIFIED `LogEntry structure`: simplify "(construction-time method, per-run extraMethod, `__hostFetch`, crypto operation)" to "(construction-time method, `__hostFetch`, crypto operation)"
- [x] 4.4 `openspec/specs/sandbox/spec.md` — MODIFIED `Host-boundary JSON serialization` requirement: change "consumer-provided `methods` or `extraMethods`" to "consumer-provided `methods`"
- [x] 4.5 `openspec/specs/sandbox/spec.md` — MODIFIED `Isolation — no Node.js surface`: drop "`/ extraMethods`" from the host-methods phrase; drop the trailing "unless a per-run `extraMethod` deliberately reinstalls one of these names" clause (the reinstallation escape hatch no longer exists)
- [x] 4.6 `openspec/specs/sandbox/spec.md` — MODIFIED `__reportError host bridge`: delete the paragraph "Per-run `extraMethods.__reportError` SHALL NOT override the construction-time binding. The `REPORT_ERROR_SHIM` captures its reference once at initialization..." (the override path is no longer expressible)
- [x] 4.7 `openspec/specs/sandbox/spec.md` — MODIFIED `Non-cloneable RPC arg is rejected` scenario inside the relevant requirement: change "a host method registered via `extraMethods`" to "a host method registered via `methods`"

## 5. WPT compliance harness spec — delta

- [x] 5.1 `openspec/specs/wpt-compliance-harness/spec.md` — MODIFIED `Harness never adds production sandbox surface`: reframe the requirement around construction-time `methods`. Body: "The WPT harness package SHALL pass `__wptReport` only via the construction-time `methods` argument of its own `sandbox(...)` call. No production sandbox construction site SHALL pass `__wptReport` in `methods`. `__wptReport` SHALL NOT be installed on any production sandbox by any other mechanism"
- [x] 5.2 Scenario `__wptReport absent in production`: rewrite `GIVEN` as "a production sandbox constructed via `sandbox(source, methods, options)` where `methods` does not contain `__wptReport`"
- [x] 5.3 Scenario `__wptReport available only during WPT runs`: rewrite `GIVEN` as "a WPT test run initiated by `sandbox(source, { __wptReport }, opts)` followed by `sb.run("__wptEntry", {})`"

## 6. SECURITY.md — alignment

- [x] 6.1 In `SECURITY.md` §2, drop references to `extraMethods` in the bridge-surface inventory. Any phrasing like "methods registered via `methods` and `extraMethods`" becomes "methods registered via `methods`"
- [x] 6.2 In `SECURITY.md` §3/§4 (if any residual references), update to construction-time-only phrasing
- [x] 6.3 Confirm no `CLAUDE.md` security invariant references `extraMethods`; if one is found, update it

## 7. Validation

- [x] 7.1 Run `pnpm lint` and confirm no new biome warnings in the touched files
- [x] 7.2 Run `pnpm check` and confirm no TypeScript errors
- [x] 7.3 Run `pnpm test` and confirm all unit + integration tests pass
- [x] 7.4 Run `pnpm test:wpt` and confirm the WPT suite still executes end-to-end with subtest results captured via the construction-time `__wptReport`
- [x] 7.5 Run `pnpm exec openspec validate drop-sandbox-extra-methods --strict` and confirm zero issues
- [x] 7.6 Grep the repo for any remaining occurrences of `extraMethods` / `extraNames` under `packages/`, `openspec/specs/`, and `SECURITY.md`; confirm the only matches are in archived changes under `openspec/changes/archive/`
