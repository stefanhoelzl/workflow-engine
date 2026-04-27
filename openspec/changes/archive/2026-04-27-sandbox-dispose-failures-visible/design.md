## Context

Today, `Sandbox.dispose()` in `packages/sandbox/src/sandbox.ts:372-385` returns `void` and ends with `worker.terminate().catch(() => {/* ignore */})`. The runtime's wrapper `disposeEntry` in `packages/runtime/src/sandbox-store.ts:127-149` does:

```ts
Promise.resolve()
  .then(() => sb.dispose())            // sync void
  .catch((err) => logger.warn(...))    // dead code: dispose() never throws
  .finally(() => pendingDisposals.delete(p));
```

Net effect:
- `worker.terminate()` rejection vanishes silently.
- `dispose()` is sync, so the `.catch` only catches synchronous throws — and `dispose()`'s body has no throwing operations.
- `pendingDisposals` deletes its tracking promise as soon as the sync `dispose()` returns, **not** when the worker has actually exited. `await store.dispose()` therefore returns while workers may still be alive.

The consequence is operator-invisible leakage during eviction and shutdown. We want the leak path surfaced at `logger.error`, and we want `await store.dispose()` to be a real shutdown barrier.

## Goals / Non-Goals

**Goals:**
- Surface previously-silent worker termination failures as structured `logger.error` lines on the runtime side, with locked-in fields `{owner, sha, reason, err}`.
- Make `Sandbox.dispose()` async with a promise that genuinely tracks worker exit.
- Make `SandboxStore.dispose()` await every worker exit before resolving.
- Ensure one failing per-entry disposal does not strand siblings during shutdown drain.
- Preserve existing synchronous semantics: pending `run()` rejection and "subsequent run() throws" must take effect immediately on the first `dispose()` call, not when its promise settles.
- Drive-by: clean up two stale spec lines (`onDied` in worker-thread-isolation, `dispose(): Promise<void>` debris in factory code block).

**Non-Goals:**
- Adding an internal timeout on `worker.terminate()`. Hangs are not a realistic failure mode for our pure-JS QuickJS workload (no native blocking syscalls); K8s grace-period SIGKILL is the backstop if Node ever did hang.
- Adding a `disposed`-detection signal. The existing `disposed` flag in `sandbox.ts:373` is cheap defence-in-depth; in practice no caller double-calls today, so surfacing "double-dispose detected" would never fire.
- Threading a logger into `sandbox.ts`. The factory has a logger in scope (`createSandboxFactory({logger})`) but we deliberately keep the runtime as the sole logger owner for dispose failures — `sandbox.ts` propagates the rejection and the runtime decides severity and structure.
- Surfacing dispose failures as `SandboxEvent`s on the bus. By the time disposal runs (eviction or shutdown), the event pipeline may already be torn down or the entry may be one the bus no longer listens for.
- Promoting dispose failure to `runtime.fatal`/`process.exit(1)` (the bus-strict-consumer precedent). Disposal is a leak, not a correctness break; the request path is unaffected.
- Tenant-visible behaviour change. `@workflow-engine/sandbox` is internal; no rebuild/re-upload, no CLAUDE.md upgrade note.

## Decisions

### D1. Make `Sandbox.dispose()` return `Promise<void>`, not `void`

**What:** Change `Sandbox.dispose(): void` (sandbox.ts:66) to `dispose(): Promise<void>`. Synchronous side-effects (`termination.markDisposing()`, rejecting all `pendingRunRejects`) execute eagerly *before* the returned promise is observed. The promise resolves when `worker.terminate()` settles, and propagates the underlying error if `worker.terminate()` rejects.

**Why over alternatives:**
- *Keep `void`, add `disposed: Promise<void>` getter.* Doubles surface area; callers must remember to await a separate property. Easy to forget, defeating the point.
- *`Promise<{ok: true} | {ok: false, err}>`.* Result-shape is un-idiomatic in this codebase, which uses rejections everywhere else for unrecoverable I/O failures.
- *Catch internally, return `Promise<void>` that never rejects.* Forces the dispose body to log, which contradicts the non-goal of threading a logger in. Caller can't distinguish success from failure.

The chosen shape lets the runtime-side `.catch(err => logger.error(...))` become *load-bearing* instead of dead code.

### D2. Idempotent dispose via cached promise

**What:** A closure-scoped `terminatePromise: Promise<void> | null`. First call assigns it; subsequent calls return the same reference. `worker.terminate()` is invoked exactly once.

```
   ┌─────────────────────────────────────────────────────┐
   │  let terminatePromise: Promise<void> | null = null  │
   │                                                      │
   │  function dispose(): Promise<void> {                 │
   │    if (terminatePromise) return terminatePromise;    │
   │    disposed = true;                                  │
   │    termination.markDisposing();                      │
   │    rejectAllPendingRuns();                           │
   │    terminatePromise =                                │
   │      worker.terminate().then(() => undefined);       │
   │    return terminatePromise;                          │
   │  }                                                   │
   └─────────────────────────────────────────────────────┘
```

**Why over alternatives:**
- *Drop the `disposed` flag, rely solely on the cached promise.* The `disposed` flag also gates `run()` rejection ("Sandbox is disposed") at sandbox.ts:256-258; that gate is sync and must remain. Both stay.
- *Return `Promise.resolve()` on second call.* Wrong semantics: caller awaiting the second call could observe success while the first call's terminate is still in-flight or about to reject.

### D3. `disposeEntry` in `sandbox-store.ts` becomes load-bearing async chain

**What:**
- Severity: `logger.warn` → `logger.error`.
- Fields: `{owner, sha, reason, err}` (locked in by spec).
- The chain becomes `await sb.dispose()` inside the per-entry handler so that `pendingDisposals` tracks worker-exit completion, not sync-return.

```
   sweep / store.dispose()
        │
        ▼
   for each entry:
     p = (async () => {
       try   { await sb.dispose(); }
       catch (err) { logger.error("sandbox dispose failed",
                                  {owner, sha, reason, err}); }
       finally { pendingDisposals.delete(p); }
     })();
     pendingDisposals.add(p);
```

### D4. `store.dispose()` uses `Promise.allSettled` semantics

**What:** Replace `await Promise.all([...pendingDisposals, ...remaining])` with a per-entry try/catch (functionally equivalent to `allSettled` but the error is logged inside the catch, so the outer `Promise.all` never rejects). One failing sandbox does not abort the await for the rest.

**Why:** Shutdown drain must visit every cached sandbox. `Promise.all` short-circuits on first rejection — that would leak the un-awaited siblings.

### D5. Sweep `sb.dispose()` call sites to `await`

**What:** Five in-tree call sites:
- `packages/sandbox/src/test-harness.ts:95`
- `packages/sandbox/src/factory.test.ts:43, 44, 67`
- `packages/runtime/src/sandbox-store.ts:136` (already in the chain — convert)

Tests previously fire-and-forget the dispose. After the change they `await` it, ensuring no floating promises during test teardown (which Vitest can flag).

### D6. Drive-by spec cleanup bundled

Two stale lines in `openspec/specs/sandbox/spec.md` removed in the same change to avoid leaving them as future-archaeology debris:
- L386: `routes run(), dispose(), and onDied()` → `onTerminated()` (the rename was completed in an earlier change but missed this paragraph).
- L495: `dispose(): Promise<void>` line in the `SandboxFactory` interface code block contradicts L522-524 which mandates "factory SHALL NOT expose a `dispose()` method." The line is stale debris from a pre-store draft.

Both fit into the MODIFIED Requirement blocks already required for the dispose change.

## Risks / Trade-offs

- **[Hung `worker.terminate()` parks `store.dispose()` indefinitely]** → K8s grace-period SIGKILL is the backstop; recovery's existing orphan-`pending/` reconciliation closes affected invocations as `trigger.error` on next boot (per CLAUDE.md "Crash-on-durability-failure" precedent for similar parked-promise semantics). For our pure-JS QuickJS workload there is no realistic native-blocking path that could cause this; we accept the theoretical risk.
- **[Out-of-tree consumers of `@workflow-engine/sandbox` break on the signature flip]** → The package is not a published author-facing surface; in-tree consumers are exhaustively swept. If a future external consumer appears, the breaking change is documented in the spec and visible in TypeScript.
- **[Idempotency cache holds a permanent reference to a rejected promise]** → Negligible (one `Promise<void>` per disposed sandbox); the entire `Sandbox` closure is GC-eligible once the runtime drops its reference. No leak.
- **[Test mock divergence from real Node `worker_threads` semantics]** → The deferred-terminate fake added to `factory.test.ts` returns a `Promise` that resolves on a manually-settled deferred. Real Node `Worker.terminate()` returns a promise that resolves with the exit code; we use `Promise<void>` shape internally (we don't propagate the exit code), so the mock divergence is at the type boundary and benign.
- **[Severity bump may surface noise from environments where dispose routinely fails]** → No such environment exists today; the current `.catch` is dead code, so promotion to `error` is from "never logged" to "logged on real failures." If a noise pattern emerges later, that is itself signal worth investigating.
