## Why

Today the sandbox reuses one QuickJS VM across every trigger invocation of a workflow. Guest-side state (`globalThis` writes, module-level `let`/`const` mutations, closures over module state) persists from one run to the next. Workflow authors approaching this from a serverless mental model will accidentally rely on that persistence in one trigger and discover surprising state leakage in another — a correctness footgun we'd rather eliminate structurally than document around.

## What Changes

- Every `sb.run()` SHALL observe a freshly-restored guest-side VM state. `globalThis` writes and module-level mutations made during one run SHALL NOT be visible to the next run. **BREAKING** for any workflow that depends on warm reuse (none exist in this repo today; demo.ts is idempotent).
- Worker-side plugin state (timers Map, pending `Callable`s, compiled action validators on `PluginSetup`) SHALL continue to persist for the sandbox's lifetime per R-4 / the existing "Per-sandbox manifest binding" requirement. The new guarantee covers **guest-side** state only.
- The sandbox worker SHALL capture a `vm.snapshot()` after init, and SHALL restore from it between runs. Restore happens off the critical path (after `run()` resolves); the next `run()` awaits any in-flight restore before executing. First run incurs no restore cost.
- A restore-phase failure SHALL mark the sandbox dead via the existing `onDied` contract; the runtime's sandbox-store respawns on next invocation.
- CLAUDE.md SHALL gain a new security invariant: plugins and workflow authors MUST NOT rely on guest-side state persisting between runs.
- SECURITY.md §2 mitigation language SHALL be updated to describe the new cross-run isolation guarantee alongside existing cross-workflow isolation.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sandbox`: the `Workflow-scoped VM lifecycle` requirement is rewritten. Text that today asserts `Module-level state and installed globals SHALL persist across run()s within the same sandbox instance` is inverted: guest state SHALL NOT persist. The `State persists across runs within a workflow` scenario is replaced by `Guest state does not persist across runs` (same source, asserted result goes `1, 2, 3` → `1, 1, 1`). Cross-sandbox isolation, dispose semantics, `onDied` on unexpected worker death, and pending-run-rejects-on-dispose scenarios are unchanged. A new scenario covers restore-failure firing `onDied`.

## Impact

- **Code**: `packages/sandbox/src/worker.ts` (state-machine extension + post-run async restore), `packages/sandbox/src/guest-function-install.ts` (extract `buildGuestFunctionHandler` so rebind can reuse it via `vm.registerHostCallback`). No changes to the main-thread `sandbox()` factory or the run/init protocol.
- **Public API**: unchanged. `Sandbox.run`, `onEvent`, `dispose`, `onDied` behave as today from the consumer perspective.
- **Performance**: per-run critical-path latency stays warm-equivalent. Per-run off-critical-path work adds ~10–17ms of async restore (measured for tiny / 113KB / 120KB bundles; bundle size has negligible impact). Back-to-back traffic pays the restore wait once; paced traffic hides it entirely.
- **Memory**: one additional permanent allocation per sandbox (~1.5–8MB for the snapshot's memory image). Per-run memory is flat once V8 GC runs (Phase 0 spike with `--expose-gc` over 2000 iterations confirmed `arrayBuffers` pinned, no retention).
- **Dependencies**: uses only public `quickjs-wasi` API (`vm.snapshot()`, `QuickJS.restore()`, `vm.registerHostCallback()`). No upstream patch.
- **Security**: narrows S13 — plugins' guest-visible long-lived state is now auto-reset. Worker-side long-lived state (R-4) is unchanged.
- **Docs**: CLAUDE.md security invariant list, SECURITY.md §2 "Fresh VM per workflow" mitigation bullet.
