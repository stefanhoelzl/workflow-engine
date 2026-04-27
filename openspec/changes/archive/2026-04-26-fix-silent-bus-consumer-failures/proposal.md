## Why

The executor's `bus.emit(widened).catch(() => {})` silently swallows every consumer failure. When persistence fails to write a `pending/{id}/{seq}.json` file, the event vanishes — never archived, never indexed by EventStore, never logged — yet the HTTP caller still receives a successful response and the runtime continues as if nothing happened. There is no log line, no metric, no signal. The bug directly contradicts the executor's own "events committed before response" guarantee and the event-bus spec's "consumer error propagates" requirement.

## What Changes

- **BREAKING (operator-visible).** Persistence failures during invocation event emission now crash the runtime (`process.exit(1)`) after logging `runtime.fatal { reason: "bus-strict-consumer-failed", … }`. Previously these failures were silently swallowed.
- `BusConsumer` interface gains `readonly name: string` (used in structured logs) and `readonly strict: boolean` (durability tier).
- `EventBus.emit` becomes the single owner of the strict-consumer fatal-exit contract. Per-consumer try/catch: best-effort consumers (`event-store`, `logging`) log `bus.consumer-failed { consumer, error }` and continue. Strict consumers (`persistence`) trigger `runtime.fatal` log + `setImmediate(process.exit(1))` from inside `bus.emit`; the returned promise never resolves, so any caller's `await bus.emit(...)` parks forever (matching production semantics that no further work runs on a doomed process).
- `createEventBus` factory signature changes from `(consumers)` to `(consumers, { logger })` — the load-bearing log keys (`bus.consumer-failed`, `runtime.fatal`) require a logger.
- New internal helper `systemShutdown(logger, reason, context)` in `packages/runtime/src/system-shutdown.ts`: logs `runtime.fatal`, schedules `setImmediate(exit)`, and returns a Promise that never resolves. Module-level `setExitFnForTests` swap for testability. The bus is the only production caller.
- Executor and recovery do NOT wrap `bus.emit` calls in their own `.catch` — they simply `await bus.emit(...)`. The bus has the durability-tier knowledge (`consumer.strict`) and is responsible for acting on it; pushing that responsibility onto callers would be a leaky abstraction (every new caller would have to relearn that "strict means fatal").
- `ExecutorOptions` does NOT gain a new `logger` field for fatal-exit purposes (the logger lives entirely on the bus). Recovery similarly keeps its existing logger only for the unrelated `runtime.recovery.archive-cleanup` info line.
- No workflow-author-visible change; no state wipe; no rebuild/re-upload required. Operators should expect `CrashLoopBackOff` (and corresponding `runtime.fatal` log lines) under storage outages where they previously saw silent data loss. Recovery's existing orphan-`pending/` reconciliation closes affected invocations as `trigger.error` on next boot.
- New CLAUDE.md upgrade-notes entry under `## Upgrade notes`.

## Capabilities

### New Capabilities

None. The fatal-exit helper is an internal module, not a capability — its contract is wholly expressed inside the event-bus spec.

### Modified Capabilities

- `event-bus`: `BusConsumer` gains `name` + `strict`; `createEventBus` factory gains required `{ logger }`; the existing "Consumer error propagates" scenario is replaced by two scenarios (best-effort logged-and-skipped, strict logged-and-runtime-terminated). The bus is the single owner of the strict-consumer fatal-exit contract.
- `persistence`: Declares `strict: true`. New explicit scenario for pending-write failure throwing — points at the event-bus contract for downstream consequences.
- `event-store`: Declares `strict: false`. Cross-references the event-bus contract for best-effort failure semantics.
- `logging-consumer`: Declares `strict: false`. Cross-references the event-bus contract for best-effort failure semantics.

`executor` and `recovery` specs are NOT modified by this change. Their existing requirements (forwarding sandbox events to `bus.emit`; replaying pending events on startup) remain unchanged. The fatal-exit happens *inside* `bus.emit`, which is invisible to the executor and recovery contracts — they call `bus.emit` and either it resolves (happy path or best-effort failure) or it never resolves (strict failure → runtime is terminating). Neither spec needs a new requirement.

## Impact

**Code:**

- New: `packages/runtime/src/system-shutdown.ts`, `packages/runtime/src/system-shutdown.test.ts`.
- Modified: `packages/runtime/src/event-bus/index.ts` (interface + factory + per-consumer try/catch + systemShutdown call on strict failure), `packages/runtime/src/event-bus/index.test.ts` (gains best-effort, strict-rethrow, and strict-fatal-exit scenarios).
- Modified: `packages/runtime/src/event-bus/persistence.ts` (`name`, `strict: true`), `packages/runtime/src/event-bus/event-store.ts` (`name`, `strict: false`), `packages/runtime/src/event-bus/logging-consumer.ts` (`name`, `strict: false`).
- Modified: `packages/runtime/src/executor/index.ts` — replace the existing `bus.emit(widened).catch(() => {})` with a plain `bus.emit(widened)`. No new logger field; the bus owns shutdown.
- Modified: `packages/runtime/src/recovery.ts` — both `bus.emit` calls become plain awaits; the `emitOrShutdown` helper is removed.
- Modified: `packages/runtime/src/main.ts` (thread logger into `createEventBus`).
- Modified: `CLAUDE.md` (new upgrade-notes entry).

**APIs:** No external API change. Workflow authors see no surface delta. The `BusConsumer` interface is internal to the runtime package.

**Operator-visible behaviour:** Pods now restart on persistence failures instead of silently corrupting invocation state. Recovery on next boot reconciles orphan `pending/` events via the existing path.

**Dependencies:** None. No new packages; no version changes.

**Risk:** A previously-degraded silent-data-loss path becomes a fail-fast crash path. Under chronic storage failure, `CrashLoopBackOff` is the expected K8s response; this is a feature, not a regression. The trade is: lose one invocation noisily on each emit failure, vs. lose every invocation silently on a single emit failure.
