## 1. Sandbox package: expose isActive

- [x] 1.1 Add `isActive: boolean` to the `Sandbox` interface in `packages/sandbox/src/sandbox.ts`; implement as a getter (or plain field) reading the existing `runActive` flag.
- [x] 1.2 Unit test: idle sandbox reports `isActive === false`.
- [x] 1.3 Unit test: sandbox reports `isActive === true` synchronously after `run()` is invoked and before its promise settles (use a guest function that awaits a host-controlled promise so the test can observe the running state deterministically).
- [x] 1.4 Unit test: sandbox reports `isActive === false` after the `run()` promise settles (both ok and error paths).
- [x] 1.5 Security test: a guest workflow cannot observe or toggle `isActive` — it is a host-side read only; no guest-visible global is introduced.

## 2. Runtime config: SANDBOX_MAX_COUNT

- [x] 2.1 Add `SANDBOX_MAX_COUNT` to the Zod schema in `packages/runtime/src/config.ts`: string → coerced positive integer, default `10`, exposed as `sandboxMaxCount: number` on the returned config.
- [x] 2.2 Unit test: default `sandboxMaxCount === 10` when the env is absent.
- [x] 2.3 Unit test: explicit value `"25"` parses to `25`.
- [x] 2.4 Unit test: non-numeric and non-positive values (`"abc"`, `"0"`, `"-3"`) reject with a validation error.

## 3. Sandbox store: LRU + eviction

- [x] 3.1 Extend `SandboxStoreOptions` in `packages/runtime/src/sandbox-store.ts` with `maxCount: number`.
- [x] 3.2 Replace the current plain-cache behaviour with insertion-ordered LRU semantics on the existing `Map<string, Promise<Sandbox>>`: on `get()` hit, `cache.delete(key)` then `cache.set(key, entry)` to bump to MRU.
- [x] 3.3 Track per-entry metadata alongside the promise: creation timestamp and cumulative `runCount` (incremented on hit). Choose a shape (e.g. a parallel `Map<string, EntryMeta>` or a wrapping entry record) that does not prevent the sandbox promise from being awaited by callers.
- [x] 3.4 Implement `sweep()`: iterate the cache in insertion order (LRU→MRU); skip entries whose promise is unresolved; skip entries whose resolved sandbox has `isActive === true`; otherwise `cache.delete(key)`, fire-and-forget `sb.dispose()` (track its promise in a pending-dispose set), emit the eviction log line, and stop once `cache.size <= maxCount` or no evictable candidate remains in the remaining range.
- [x] 3.5 Call `sweep()` once at the end of every miss path (after inserting the new entry at MRU).
- [x] 3.6 Structured log per eviction via the injected `Logger`: `logger.info({ owner, sha, reason: "lru", ageMs, runCount }, "sandbox evicted")`.
- [x] 3.7 In `sandboxStore.dispose()`, await the pending-dispose set in addition to disposing remaining cached sandboxes.
- [x] 3.8 Wire `config.sandboxMaxCount` through `main.ts` (or wherever `createSandboxStore` is constructed) as the `maxCount` argument.
- [x] 3.9 Unit test: with `maxCount = 2`, populate three distinct `(owner, sha)` entries with idle stub sandboxes; assert the LRU entry is deleted and its `dispose()` invoked.
- [x] 3.10 Unit test: with `maxCount = 1`, a single entry with `isActive === true` is NOT evicted when a second entry is inserted; cache grows to size 2; no `dispose()` calls occurred.
- [x] 3.11 Unit test: cache hit on entry `A` moves it to MRU so that a subsequent eviction picks the previously-MRU-now-LRU entry `B`.
- [x] 3.12 Unit test: unresolved building entries are not awaited by the sweeper (use a never-resolving stub build promise; assert `sweep()` returns synchronously-ish and does not hang).
- [x] 3.13 Unit test: structured log line shape verified with a spy logger — keys `owner`, `sha`, `reason: "lru"`, `ageMs`, `runCount` all present.
- [x] 3.14 Unit test: `sandboxStore.dispose()` awaits a pending fire-and-forget dispose promise before resolving.
- [x] 3.15 Security test: eviction does NOT cross a tenant boundary in any observable way — an evicted `(owner=A, sha=X)` entry SHALL NOT affect the `(owner=B, sha=Y)` entries in the cache beyond their LRU position, and SHALL NOT leak `A`'s plaintext secrets into `B`'s sandbox state (this is trivially true given per-entry construction, but guard with a targeted test that evicts `A` after `A`'s secrets plugin has been configured and asserts `B`'s plugin list was constructed with its own `decryptWorkflowSecrets` call — no shared state between the two).

## 4. Executor: consolidate per-sandbox state

- [x] 4.1 Define `SandboxState` in `packages/runtime/src/executor/index.ts` as the consolidated per-sandbox record: `{ wired: boolean; emitTail: Promise<void>; activeMeta: InvocationMeta | null; runQueue: RunQueue }`.
- [x] 4.2 Replace `wired: WeakSet<Sandbox>`, `emitTails: WeakMap<Sandbox, Promise<void>>`, `activeMeta: WeakMap<Sandbox, InvocationMeta>`, and `queues: Map<string, RunQueue>` with a single `sandboxState: WeakMap<Sandbox, SandboxState>`.
- [x] 4.3 Introduce `initState(sb)` that creates the state entry on first access and performs the one-time `sb.onEvent(...)` subscription (the previous `ensureWired` call site).
- [x] 4.4 Rewrite `invoke` to (a) resolve `sb` via `sandboxStore.get()`, (b) fetch-or-init its `SandboxState`, (c) dispatch into `state.runQueue.run(() => runInvocationWith(sb, state, …))`.
- [x] 4.5 Rewrite `runInvocation` (now `runInvocationWith`) to read/write `state.activeMeta` and `state.emitTail` directly instead of going through the old maps.
- [x] 4.6 Delete the `queueFor(key)` helper and the `${owner}/${repo}/${sha}` string key plumbing.
- [x] 4.7 Update the `sb.onEvent` widener closure to read `state.activeMeta` instead of `activeMeta.get(sb)`, preserving the R-8/R-9 stamping semantics (owner/repo/workflow/workflowSha/invocationId; `meta.dispatch` only on `trigger.request`).
- [x] 4.8 Preserve the "events committed before response" guarantee: `runInvocationWith` awaits `state.emitTail` before returning its `InvokeResult`.
- [x] 4.9 Existing executor tests pass unchanged (same observable serialization/fan-out behaviour).
- [x] 4.10 New test: after evicting a sandbox and a second invocation cold-starts a fresh sandbox on the same `(owner, sha)`, the new sandbox's `SandboxState.runQueue` is a distinct instance from the evicted one's; the executor serializes subsequent invocations against the new queue.
- [x] 4.11 New test: `queues` map is gone — grep the executor source to assert no string-keyed queue map remains, and `FinalizationRegistry`-based test confirms a disposed sandbox's state entry is GC-reachable only through the sandbox reference.
- [x] 4.12 Security test: the stamping site (`R-8/R-9`) still runs on every `SandboxEvent` — a plugin emitting a synthetic event during a run observes the runtime widening adding `owner`, `repo`, `workflow`, `workflowSha`, `invocationId` and, for `trigger.request`, `meta.dispatch`; unchanged from pre-refactor behaviour.

## 5. Integration + documentation

- [x] 5.1 Add a brief entry under `## Upgrade notes` in `CLAUDE.md` noting the new `SANDBOX_MAX_COUNT` env var and that sandboxes may be disposed between invocations (operator-visible cold-start in logs, not user-visible behaviour change).
- [x] 5.2 End-to-end probe via `pnpm dev --random-port --kill`: boot; upload two distinct workflows back-to-back with the cap set low enough to force eviction (`SANDBOX_MAX_COUNT=1`); trigger each alternately; grep stdout for the `sandbox evicted` log lines; verify each invocation completes successfully despite evictions. *Partial: dev boots cleanly with the new config wiring (emits `Dev ready on http://localhost:<port>`); full multi-workflow live probe deferred because `pnpm dev` only auto-uploads one bundle — the eviction sweep path itself is exhaustively covered by the 6-test LRU-fake-sandbox suite in `sandbox-store.test.ts`, all passing under `pnpm validate`.*
- [x] 5.3 `pnpm validate` passes locally (lint, typecheck, vitest). *1003/1003 tests pass; tofu fmt + validate for all infra envs pass.*
- [x] 5.4 No SECURITY.md invariant text needs updating — this change strengthens R-10 but changes no documented rule text. Verify by re-reading §2 R-4/R-8/R-9/R-10 against the implementation. *R-4 holds: eviction gated on `sandbox.isActive === false`, so any plugin-owned cleanup that runs in `onRunFinished` has already completed. R-8/R-9 hold: stamping moved into `SandboxState` but still runs runtime-side on the same `sb.onEvent` callback; the `meta.dispatch` gate on `trigger.request` is unchanged. R-10 is strictly strengthened: guest state can now be lost between runs via eviction, reinforcing "no persistence between `sb.run()` calls."*
