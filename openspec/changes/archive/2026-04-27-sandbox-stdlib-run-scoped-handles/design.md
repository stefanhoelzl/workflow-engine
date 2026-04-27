## Context

Stdlib plugins that allocate per-call host resources (timers, sql, mail, fetch) need deterministic teardown at run end so resources don't escape the QuickJS snapshot-restore boundary. The Node worker thread persists across runs; only the QuickJS VM is restored from a snapshot. Async work the dispatcher started during run N (e.g., an awaited `transport.sendMail` whose guest didn't `await` the host call) keeps running on the worker into run N+1's window unless the plugin explicitly tears it down via `onRunFinished`.

Three of the four affected plugins already have backstops:

- `timers` (`packages/sandbox-stdlib/src/timers/index.ts:207-209`) — clears all live timers via the same code path as guest-initiated `clearTimeout`.
- `sql` (`packages/sandbox-stdlib/src/sql/worker.ts:421-426, 613-622`) — drains an `openHandles: Set<SqlHandle>` via `Promise.allSettled`.
- `mail` (`packages/sandbox-stdlib/src/mail/worker.ts:472-474`) — **MISSING**. Only the per-call `finally { transport.close() }` exists; no run-end backstop.
- `fetch` (`packages/sandbox-stdlib/src/fetch/index.ts:100-102`) — has no backstop; in-flight requests bounded only by the 30s `composeSignal` wall-clock cap. Audit-safe via the worker gate, but unfair to the next run's worker time budget.

The investigation traced the *audit-corruption* concern (would late events be mis-stamped onto the next run's `invocationId`?) into `packages/sandbox/src/worker.ts:665-676`, where `bridge.clearRunActive()` after `runLifecycleAfter` ensures any post-`done` host-callback emissions are silently suppressed at the worker source. The sequencer's `finish()` synthesizes close frames for any dangling open frames using the current run's stamping. **Audit safety is therefore independent of whether a plugin has a backstop** — late real events never reach the executor's `sb.onEvent`. The backstop's job is *resource-lifetime determinism* and *worker-time fairness*, not audit correctness.

## Goals / Non-Goals

**Goals:**
- Close mail's R-4 gap: SMTP socket lifetime bounded to the run that opened it.
- Close fetch's worker-time-fairness gap: in-flight fetches abort at run end so they don't consume budget during run N+1.
- Unify the two existing per-call-resource backstops (sql + timers) and the two new ones (mail + fetch) under one helper so the pattern is enforced by code shape, not memorised by plugin authors.
- Establish a written, review-enforced policy for future system-bridge plugins so the next gap isn't found by audit.

**Non-Goals:**
- A `createSystemBridgePlugin(spec)` higher-order factory unifying mail/sql/fetch under a strategy interface. Rule of Three is borderline (mail + sql are too similar; fetch is structurally different) and no fourth plugin yet exists to validate the abstraction shape. Deferred.
- Refactoring the timers plugin's existing backstop. It already routes through guest-equivalent emission paths (`clearTimeout` audit events) which the helper does not handle; touching it is out of scope.
- Refactoring net-guard ordering, error classification, redaction logic, or timeout policy. Each plugin keeps its current driver-specific implementation.
- Changing event surface, manifest format, SDK exports, or any author-visible contract.
- Modifying the worker-side `bridge.clearRunActive()` gate. The gate is pre-existing and load-bearing; any change would alter audit semantics for all plugins.

## Decisions

### Decision 1: Helper shape — return `track`, `release`, `drain`

Helper signature:

```ts
interface RunScopedHandles<T> {
  track(handle: T): T;                      // returns its arg for inline use
  release(handle: T): Promise<void>;        // delete + await close, swallow errors
  drain(): Promise<void>;                   // Promise.allSettled over remaining
}

function createRunScopedHandles<T>(
  close: (h: T) => Promise<void> | void,
): RunScopedHandles<T>;
```

**Why this shape over alternatives:**
- `track(h: T): T` returning its argument enables inline use: `const transport = handles.track(nodemailer.createTransport(opts))`. Mirrors how `Map.set` returns the map; common ergonomic pattern.
- `release` is async because at least one closer (sql's `sql.end({timeout:0})`) is async. Mail's sync `transport.close()` returns void and is auto-awaited.
- `drain` uses `Promise.allSettled` so one slow/throwing closer doesn't block the others, matching SQL's existing semantics.
- Errors from `close` are swallowed inside the helper (`.catch(() => undefined)`) so neither callsite has to wrap. Matches SQL's existing `.catch(() => undefined)` on the per-call `finally`.

**Alternatives considered:**
- A class. Violates `factories over classes` project convention.
- A `using` / `Symbol.dispose` based API. TypeScript explicit-resource-management is supported but mixing sync-disposable with async work is awkward; helper pattern is simpler at this scope.
- Returning the `Set` directly. Leaks the storage to call sites and invites them to mutate it directly, defeating the encapsulation that the helper exists to provide.

### Decision 2: Helper home — `packages/sandbox-stdlib/src/internal/run-scoped-handles.ts`

Internal to sandbox-stdlib, not exported from the package index. Only mail, sql, fetch import it.

**Why:**
- Two consumers today, growing to three with this change. No external use case.
- Keeps the API surface of `@workflow-engine/sandbox-stdlib` unchanged.
- If a future stdlib plugin needs it, no API surface change is required to consume it.
- If a third-party out-of-tree plugin needs it later, the helper graduates to `packages/sandbox/` (alongside other plugin-author affordances) at that point — explicit cross-package promotion, not accidental coupling.

**Alternative considered:** placing it in `packages/sandbox/` (exported from `@workflow-engine/sandbox`) — rejected as premature surface commitment.

### Decision 3: Fetch tracks `AbortController`, not the request promise

Fetch's "handle" is the per-call `AbortController` composed via `composeSignal` (existing logic in `hardened-fetch.ts:316`). The closer calls `controller.abort()`, which causes the in-flight `undici` request (or any await chain on the signal) to reject with `AbortError`. The dispatcher's `try/catch/finally` then runs as if the caller had aborted manually; `release()` removes the controller from the set after the abort resolves the await chain.

**Why:**
- The undici Agent itself is a process-wide cached resource (`hardened-fetch.ts:54`); per-run tracking would be wrong (would tear down the pool on every run).
- The actual per-call resource is the in-flight request. Aborting it is the natural closer.
- AbortController is what `composeSignal` already produces internally; lifting it into the dispatcher's scope is a minimal refactor.

**Implementation note:** `hardenedFetch` currently *creates* the composed signal internally and never returns the controller. Decision 3a follows.

### Decision 3a: Lift the run-scoped controller out of `composeSignal`

`hardenedFetch` will accept an externally-supplied `AbortController` (or expose the composed one back to the descriptor handler) so the descriptor handler in `fetch/index.ts` can `handles.track(controller)` before awaiting the response. Two viable shapes:

- (a) Add a `controller` parameter to `hardenedFetch`; default-construct one if omitted (preserves test ergonomics).
- (b) Have `hardenedFetch` return both `Promise<Response>` and the controller via a helper.

(a) is preferred — narrower surface change, single new optional parameter. Existing tests construct `hardenedFetch` directly and pass a `signal`; the new parameter is orthogonal.

### Decision 4: Per-call `release` calls the same closer as `drain`

Both per-call `finally` paths and the `onRunFinished` drain go through `release()` / `drain()` which call the same user-supplied `close` function. There is no separate "fast-path close" for the happy case.

**Why:**
- Symmetric behaviour: a closer that's safe to call from `drain` is safe to call from `release`. Anything else invites bugs where the two paths drift.
- Closers must already tolerate being called once (per-call) or zero times (the leak case `drain` catches). The race between `release` finishing and `drain` running is benign because:
  - Mail's `SMTPTransport.close()` is idempotent under double-call (verified against nodemailer 6.10.1: `removeAllListeners` + `emit('close')`, no I/O).
  - SQL's `sql.end({timeout: N})` is documented idempotent: `if (ending) return ending` (`postgres@3.4.9 src/index.js:366`).
  - Fetch's `controller.abort()` is idempotent on AbortController.
- Helper deletes the handle from its tracking Set *before* awaiting close, so a `drain()` that races with an in-flight `release()` won't double-process the same handle.

### Decision 5: SQL refactor lands in the same PR

SQL is already correct; the refactor is purely shape-unification. Reasons to bundle:

- Ensures the helper's API shape is validated against two real callers (sql + mail), not one + a hypothetical (mail). Fetch is the third caller.
- Three concrete adopters in one PR makes the pattern visible to reviewers and prevents the helper from being added in a state that only fits its newest caller.
- Behaviour-preserving change inside a single file; minimal additional review cost.

**Risk:** SQL is security-critical (R-S4 net-guard ordering, TLS pinning, credential handling). The refactor must preserve every invariant. Mitigation: line-by-line preservation of the existing `try { … } finally { openHandles.delete(sql); await sql.end({timeout:0}).catch(() => undefined); }` semantics; the helper's contract (delete-before-close, swallow-errors) is identical to what SQL does today.

### Decision 6: SECURITY.md R-4 refinement + new "Adding a system-bridge plugin" subsection

R-4 today says "plugins with long-lived state MUST implement onRunFinished." The Threads 2/3 investigation produced a sharper rule: it's **per-call resources**, not "long-lived state" generically, that need a backstop; **pool-shared resources** are governed by their pool. Refining R-4 to encode this rule turns the audit logic into reusable policy.

The new "Adding a system-bridge plugin" subsection codifies the seven-item checklist (net-guard ordering, run-scoped handles, `system.*` prefix, structured errors, redacted logging, timeouts, JSON-serializable config) so a future plugin author has a single place to look. Review-enforced today; once a fourth per-call-resource plugin lands, a `createSystemBridgePlugin` factory may convert several checklist items into structural enforcement.

## Risks / Trade-offs

[**Risk**: Aborting an in-flight fetch at run end is a behaviour change for guests that fire-and-forget (analytics beacons, webhook posts).] → **Mitigation**: The audit-event close frame for the request is already synthesized by the sequencer at run end regardless of the abort, so the visible audit shape is unchanged. The actual breakage is "the request may not complete." This is acceptable because (a) firing-and-forgetting host calls is not a documented or supported guest pattern, (b) any guest that needs the request to complete must `await` it (which keeps the run alive past the abort), (c) the alternative is borrowing up to 30s of worker time from the next run, which is a worse contract.

[**Risk**: The helper introduces a new place where future bugs could land — single point of failure for cleanup across three plugins.] → **Mitigation**: Helper is ~30 lines, has its own unit tests, and is internal to sandbox-stdlib. The single-point-of-failure concern is the inverse of the goal (one place to enforce the rule); the trade is intentional.

[**Risk**: SQL refactor regresses on a security-critical plugin.] → **Mitigation**: Behaviour-preserving change; existing SQL tests must continue to pass without modification. Manual diff review against the line-by-line semantic mapping (see Decision 4).

[**Risk**: nodemailer's `SMTPTransport.close()` semantics change in a future major version (e.g., becomes async, becomes non-idempotent).] → **Mitigation**: Verified against nodemailer 6.10.1 (current `^6.9.16` constraint in `packages/sandbox-stdlib/package.json`). The closer wraps `transport.close()` in `try/catch` regardless. Future major-version upgrades of nodemailer require re-verification of the closer contract; called out in the upgrade notes once the upgrade lands.

[**Risk**: AbortController-based fetch tracking misses an undici-internal pool reuse path that holds the connection open beyond the run end.] → **Mitigation**: undici's pool is process-wide *by design*; aborting a request returns the underlying socket to the pool (or destroys it), which is correct behaviour. The risk is fictional: pool sockets are not "this run's resource."

[**Risk**: A guest pattern emerges where fire-and-forget mail / fetch / sql is the intended use case (e.g., logging-style sends).] → **Mitigation**: Document in SDK ergonomics that host calls must be awaited if the guest wants their effect guaranteed. Separate from this change.

## Migration Plan

No migration. No tenant rebuild required. No state wipe. No event format change. No log line removal. The only post-deploy difference is that on a worker that previously had a leaked in-flight `sendMail` / `fetch`, the resource now closes at run end instead of whenever the I/O resolves naturally. Both paths produce the same audit-event shape; only timing changes.

Roll-forward only. Rollback is a `git revert` of the PR.

## Open Questions

- Final placement of the helper: confirmed `packages/sandbox-stdlib/src/internal/run-scoped-handles.ts`. Re-verify during implementation that `internal/` is the established convention for non-exported modules in this package (a quick grep at task time).
- Whether `hardenedFetch` should accept an externally-supplied `AbortController` (Decision 3a option a) or return the composed controller alongside the response (option b). Pinned to (a) above; revisit only if option a turns out to break test ergonomics.
- Whether to verify `nodemailer.createTransport()` is non-eager (does not open a socket before `sendMail`) — if it *is* eager, the helper still works (track happens immediately after construction), but the assumption that "release just calls close()" deserves a code-comment grounded in observation rather than deduction. Verification belongs in the implementation phase, not this design.
