## Context

`extraMethods` was introduced in `2026-04-14-sandbox-package` to support per-run host methods that close over invocation-local state. The motivating use case at the time was `emit(type, payload)` — each run installed an `emit` function that closed over the current event so guest code could write `emit("foo", {...})` without the host having to route it by invocation id.

That use case was subsequently migrated away. `2026-04-16-invocation-event-stream` moved invocation metadata into `RunOptions` (`invocationId`, `workflow`, `workflowSha`) and established a construction-time `__emitEvent` host bridge. Under the current model the `emit` capability is entirely construction-time: one function, stateless, with invocation attribution derived from `RunOptions` (and threaded through the bridge's per-request context).

What remains using `extraMethods` in-tree: exactly one call site, in the WPT harness (`packages/sandbox/test/wpt/harness/runner.ts:79`), which installs `__wptReport` so the guest-side harness can push subtest results back to the runner. The harness already constructs one fresh sandbox per test (`runner.ts:71`), so the scope of `__wptReport` is effectively the lifetime of the sandbox, not the lifetime of a single `run()` call. Per-run scoping buys nothing the current harness uses.

## Decisions

### D1. Delete `extraMethods` from the public API

**Chosen:** Remove `extraMethods` from `RunOptions`. All host methods flow through the construction-time `methods` argument of `sandbox(source, methods, options)`. The `Sandbox.run` signature becomes `run(name, ctx, options: RunOptions)` where `RunOptions = { invocationId, workflow, workflowSha }`.

**Rationale:** No consumer requires per-run method scoping after the `emit` → `__emitEvent` migration. Construction-time registration is sufficient for every current and planned pattern. The `methods` argument is already there; adding a second channel just for a redundant scope is dead surface.

**Rejected — "deprecate, keep surface":** Leaving `extraMethods` on `RunOptions` as a no-op would preserve compatibility with hypothetical future consumers but pay the full cost of the existing code paths (collision detection, per-run install/uninstall) for no benefit. Dead surface rots.

### D2. Move `__wptReport` to construction-time methods

**Chosen:** `runWpt` constructs `sandbox(source, { __wptReport }, { memoryLimit })`. The `__wptReport` closure references `captured: SubtestResult[]`, a runner-local array. Because each `runWpt` call builds its own `Sandbox`, each `captured` lives exactly as long as the sandbox that writes to it — equivalent to the current per-run scope.

**Rationale:** The WPT harness's existing isolation model is "one sandbox per test". That matches construction-time methods perfectly — the closure captures a test-local array, and the sandbox's lifetime equals the test's lifetime. No shared state leaks between tests because the sandbox is rebuilt each time.

**Rejected — "share one sandbox across multiple WPT tests":** Ambitious future optimization that would re-motivate per-run scoping. Not on the roadmap. If it ever is, it can bring back a scoped-method mechanism as part of its own proposal.

### D3. Realign spec `run()` signature with code

**Chosen:** The spec block declaring `Sandbox.run(name, ctx, extraMethods?)` is rewritten to match the real shape — `run(name, ctx, options: RunOptions)` with the full `RunOptions` type block — in the same change.

**Rationale:** The spec has been drifted from code since `2026-04-16-invocation-event-stream` (which added `invocationId`/`workflow`/`workflowSha` to `RunOptions` but apparently didn't update the `Public API — Sandbox.run()` signature block). Fixing the drift in a spec-only hotfix would be a separate one-line change; folding it into this removal saves a round-trip and keeps the `Public API` requirement consistent after the change lands.

### D4. Keep the requestId-correlation scenario (rewritten)

**Chosen:** The `Concurrent extra-method requests correlate via requestId` scenario is retained and rewritten to exercise a construction-time method instead of a per-run one. The property under test — that concurrent bridge calls are correctly correlated by `requestId` — is a property of the RPC layer, not of where methods were installed.

**Rationale:** The correlation behavior is real and worth pinning. Dropping the scenario entirely would leave a gap. Rewriting preserves coverage intent without referencing the removed API.

### D5. Remove `extraMethods` references from adjacent spec requirements

The current spec mentions `extraMethods` in six places beyond the `Public API — Sandbox.run()` requirement:

1. `RunResult discriminated union` — "The method MAY throw for host-side programming errors (e.g., invalid extraMethods collision, sandbox already disposed)." → drop the collision example; sandbox-disposed still applies.
2. `LogEntry structure` — "Every host-bridged method call (construction-time method, per-run extraMethod, `__hostFetch`, crypto operation) SHALL push an entry" → simplify to "host-bridged method call (construction-time method, `__hostFetch`, crypto operation)".
3. `Host-boundary JSON serialization` — "consumer-provided `methods` or `extraMethods`" → "consumer-provided `methods`".
4. `Isolation — no Node.js surface` — "the host methods registered via `methods` / `extraMethods`" plus a trailing clause about per-run `extraMethod` reinstallation of captured bridges. → drop both references. The reinstallation clause was cover for an edge case that no longer exists.
5. `__reportError host bridge` — an entire paragraph about per-run `extraMethods.__reportError` not overriding the shim's captured reference. → delete the paragraph. Without `extraMethods`, no override path exists to clarify.
6. `Non-cloneable RPC arg is rejected` — the `GIVEN` names "a host method registered via `extraMethods`". → change to "a host method registered via `methods`". Property under test is unchanged.

Each edit is mechanical and the property being specified is preserved.

### D6. WPT spec reframing

The `Harness never adds production sandbox surface` requirement currently says: "The WPT harness package SHALL NOT register any host method, global, or bridge on the sandbox except via per-run `extraMethods` to `sandbox.run()`." That formulation ties the invariant to the `extraMethods` mechanism. Post-removal, the invariant becomes tied to the construction-time `methods` argument: "the WPT harness SHALL pass `__wptReport` only via the construction-time `methods` argument of its own `sandbox(...)` call; no production sandbox construction site SHALL pass `__wptReport` in `methods`." Same property, different mechanism.

The two scenarios update accordingly:
- `__wptReport absent in production`: "GIVEN a production sandbox constructed with a `methods` map that does not contain `__wptReport`" → guest call throws `ReferenceError`.
- `__wptReport available only during WPT runs`: "GIVEN a WPT test run via `sandbox(source, { __wptReport }, opts)` followed by `sb.run("__wptEntry", {})`" → guest call reaches host.

## Risks / Trade-offs

- **Breaking an internal-only API is usually cheap, but the spec touches seven requirements across two capabilities.** Mitigation: each edit is mechanical; no property under test is removed; the `requestId` correlation scenario is preserved via rewrite. The change proposal captures all seven edits as `MODIFIED` deltas.
- **Re-adding per-run scoping later if needed.** If a future consumer needs host methods that close over per-run state that isn't capturable via `ctx` or a request-context, they'll need a new mechanism. That's not free — but (a) we don't have that consumer today, and (b) the re-introduction can be targeted to the real use case instead of the generic `Record<string, Promise-fn>` shape we have now.
- **Hosts who were relying on `extraMethods` outside the repo.** The sandbox package is an internal dependency; there are no public consumers. No migration path for external callers is needed.
- **WPT closure semantics.** The runner-local `captured` array is closed over by `__wptReport` at sandbox construction. Each `runWpt` builds its own sandbox, so each `captured` is owned by exactly one sandbox's `__wptReport` invocations. No cross-test contamination.

## Migration Plan

1. Delete the field + dispatch logic in `packages/sandbox/src/index.ts`.
2. Delete per-run install/uninstall in `packages/sandbox/src/worker.ts`.
3. Drop `extraNames` from the internal `run` MainToWorker message shape.
4. Update `packages/sandbox/test/wpt/harness/runner.ts` to pass `__wptReport` via `methods`.
5. Update `packages/sandbox/test/wpt/README.md`.
6. Apply spec deltas (sandbox + wpt-compliance-harness).
7. Apply `SECURITY.md` edits.
8. Run `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm test:wpt`, `pnpm exec openspec validate drop-sandbox-extra-methods --strict`.

No runtime coordination required — the production call site in `workflow-registry.ts` already omits `extraMethods`.
