## Why

`Sandbox.dispose()` is currently sync `void` and ends with `worker.terminate().catch(() => {/* ignore */})` (`packages/sandbox/src/sandbox.ts:382-384`). The runtime's wrapper at `packages/runtime/src/sandbox-store.ts:135-148` then catches synchronous throws from `dispose()`, but since `dispose()` cannot throw synchronously today, that `.catch` is dead code. Net effect: any failure inside `worker.terminate()` (rejection, hang) disappears with no operator signal, and `SandboxStore.dispose()`'s `pendingDisposals` set tracks only "did `dispose()` return?" — not "did the worker actually exit?" — so `await store.dispose()` can return while workers are still alive.

## What Changes

- **BREAKING (sandbox package API)**: `Sandbox.dispose()` returns `Promise<void>` instead of `void`. Synchronous side-effects (mark disposing, reject pending runs) still execute eagerly before the promise is returned. The promise resolves when `worker.terminate()` settles, and rejects with the underlying error if `worker.terminate()` rejects.
- `Sandbox.dispose()` is idempotent: subsequent calls return the same in-flight promise and do not initiate a second `worker.terminate()`.
- `SandboxStore.disposeEntry` promotes `logger.warn` → `logger.error`, with structured fields `{owner, sha, reason, err}` locked in by spec.
- `SandboxStore.dispose()` switches from `Promise.all` to per-entry catch (`Promise.allSettled` semantics) so a single failing sandbox does not strand the rest, and SHALL await all worker exits before resolving.
- Sweep all in-tree call sites of `sb.dispose()` to `await sb.dispose()` (`packages/sandbox/src/test-harness.ts`, `packages/sandbox/src/factory.test.ts`, plus runtime call sites).
- Drive-by spec cleanup: in `openspec/specs/sandbox/spec.md`, remove the stale `dispose(): Promise<void>` line from the `SandboxFactory` code block (factory has no dispose), and update the stale `onDied` reference in the `worker_threads` paragraph to `onTerminated`.

## Capabilities

### New Capabilities

(none — `SandboxStore` requirements continue to live inside the existing `sandbox` capability)

### Modified Capabilities

- `sandbox`: tighten the `Sandbox dispose lifecycle` requirement to mandate `Promise<void>` shape, idempotent re-entry, and rejection on `worker.terminate()` failure; add a new `SandboxStore dispose error reporting` requirement covering error-severity logging, structured field shape, and await-all-worker-exits semantics; remove stale debris in the factory code block and the `onDied` legacy reference.

## Impact

- **Code**:
  - `packages/sandbox/src/sandbox.ts` — dispose signature + idempotency cache + terminate-promise propagation.
  - `packages/runtime/src/sandbox-store.ts` — log severity bump, per-entry catch, await semantics.
  - `packages/sandbox/src/test-harness.ts`, `packages/sandbox/src/factory.test.ts` — `await sb.dispose()` sweep.
  - `packages/sandbox/src/factory.test.ts` — extend the existing `worker_threads` mock with a deferred-terminate fake to exercise the new scenarios (idempotency, error logging shape, await-worker-exit).
- **Specs**: `openspec/specs/sandbox/spec.md` modified per the deltas above.
- **APIs**: `Sandbox.dispose()` signature change is internal — `@workflow-engine/sandbox` is not a published author-facing surface, no tenant rebuild required, no CLAUDE.md upgrade note.
- **Dependencies**: none added or removed.
- **Operator-visible behaviour**: previously-silent worker termination failures now surface as `logger.error("sandbox dispose failed", {owner, sha, reason, err})`. `await store.dispose()` is now a real shutdown barrier instead of a fire-and-forget signal; under a hung `worker.terminate()`, K8s grace-period SIGKILL remains the backstop.
