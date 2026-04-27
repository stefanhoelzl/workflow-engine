## 1. system-shutdown helper

- [x] 1.1 Create `packages/runtime/src/system-shutdown.ts` exporting `systemShutdown(logger, reason, context): Promise<never>` and `setExitFnForTests(fn)`. Implementation: log `runtime.fatal { reason, ...context }` at error level, then `await new Promise<never>((_resolve) => { setImmediate(() => exitFn()); })` followed by an unreachable `throw new Error("unreachable")` for the `Promise<never>` return type.
- [x] 1.2 Module-level `let exitFn: () => void = () => process.exit(1);` with `setExitFnForTests(fn)` swap. Add a one-line header comment marking the test hook as test-only.
- [x] 1.3 Create `packages/runtime/src/system-shutdown.test.ts` covering: (a) logger receives `runtime.fatal` with the right reason + context shape; (b) `setImmediate`-scheduled exit hook fires exactly once; (c) the returned promise stays pending (use a race against a short `setTimeout` to prove non-resolution); (d) `setExitFnForTests` reset in `beforeEach`/`afterEach`, with `setImmediate` drain in `afterEach` so pending callbacks don't cross test boundaries.

## 2. Bus interface, factory, and fatal-exit ownership

- [x] 2.1 Update `packages/runtime/src/event-bus/index.ts`: extend `BusConsumer` with `readonly name: string` and `readonly strict: boolean`. Change `createEventBus` signature to `(consumers: BusConsumer[], opts: { logger: Logger }): EventBus`.
- [x] 2.2 Replace the bus's emit loop with per-consumer try/catch. On throw: `opts.logger.error("bus.consumer-failed", { consumer: c.name, error })`. If `c.strict`, `await systemShutdown(opts.logger, "bus-strict-consumer-failed", { consumer: c.name, id, kind, seq, owner, workflowSha, error })` — `bus.emit` never resolves under this path.
- [x] 2.3 Update `packages/runtime/src/event-bus/index.test.ts`: split the existing "consumer error propagates" test into three new tests matching the spec scenarios — best-effort logged-and-skipped, strict logs `bus.consumer-failed`, and strict triggers `systemShutdown` (asserts exit spy fires, `runtime.fatal` logged with the right reason and event context, `bus.emit` never resolves).
- [x] 2.4 Add a test that constructs a bus with a logger spy and an empty consumer list — `bus.emit(event)` resolves without errors and the logger is not called.

## 3. Consumer tier declarations

- [x] 3.1 `packages/runtime/src/event-bus/persistence.ts`: declare `name: "persistence"` and `strict: true` on the returned consumer object.
- [x] 3.2 `packages/runtime/src/event-bus/event-store.ts`: declare `name: "event-store"` and `strict: false` on the returned consumer object.
- [x] 3.3 `packages/runtime/src/event-bus/logging-consumer.ts`: declare `name: "logging"` and `strict: false` on the returned consumer object.
- [x] 3.4 Add a focused test in each consumer's test file (or add to existing): assert the `name` and `strict` values match the spec.

## 4. Persistence pending-write-throws scenario

- [x] 4.1 Add a test in `packages/runtime/src/event-bus/persistence.test.ts` (or equivalent) covering the new "Pending write rejection re-throws and leaves accumulator untouched" scenario from the persistence spec delta. Use a mock `StorageBackend` whose `write` rejects on a specific path; assert (a) `handle` rejects with the same error; (b) the accumulator does not include the failing seq.

## 5. Executor cleanup

- [x] 5.1 Update `packages/runtime/src/executor/index.ts`: remove the `.catch((err) => systemShutdown(...))` wrapper introduced earlier in this change. The line becomes a plain `state.emitTail = state.emitTail.then(() => bus.emit(widened));`. Remove the `Logger` import and the `logger` field from `ExecutorOptions` if they were added solely for the fatal-exit path. The executor no longer references `systemShutdown`.
- [x] 5.2 Remove the executor's "Strict consumer rejection logs runtime.fatal and schedules exit" test (it's covered by the bus test now). Replace with a smoke test asserting that under a rejecting bus stub, `executor.invoke` never resolves — the executor-side observable. Best-effort smoke test (bus resolves cleanly even when consumers fail internally) can stay.
- [x] 5.3 Update every existing `createExecutor` call site to drop the `logger` field (test file + main.ts) if it was added solely for fatal-exit. If `logger` is still used by the executor for non-fatal-exit purposes, keep it; otherwise drop.

## 6. Recovery cleanup

- [x] 6.1 Update `packages/runtime/src/recovery.ts`: remove the `emitOrShutdown` helper. Both `bus.emit` calls become plain `await bus.emit(event)` statements. `RecoveryDeps.logger` stays (still used for `runtime.recovery.archive-cleanup`); the import of `systemShutdown` is removed.
- [x] 6.2 Remove the recovery test "logs runtime.fatal and schedules exit when bus.emit rejects during replay" (covered by the bus test). Replace with a smoke test asserting that under a rejecting bus stub, `recover()` never resolves.

## 7. Main wiring

- [x] 7.1 `packages/runtime/src/main.ts`: pass `runtimeLogger` into `createEventBus(consumers, { logger: runtimeLogger })`. Drop the `logger: runtimeLogger` from `createExecutor` if it was added only for fatal-exit (depends on the outcome of task 5.1).

## 8. Documentation

- [x] 8.1 CLAUDE.md upgrade-notes entry already drafted with the bus-owns-shutdown framing. Re-read it after the refactor to confirm it still matches: it should describe the bus terminating the runtime, not the executor or recovery doing so.

## 9. Validate

- [x] 9.1 `pnpm exec openspec validate fix-silent-bus-consumer-failures --strict` passes.
- [x] 9.2 `pnpm validate` passes (lint, type check, unit + integration tests; WPT not required for this change).
- [x] 9.3 Smoke-probe via `pnpm dev --random-port --kill`: boot succeeds, runtime registers workflows, zero `runtime.fatal` or `bus.consumer-failed` log lines.
- [x] 9.4 Fault-injection coverage is provided by the bus test added in 2.3: stubs a strict consumer to reject, uses `setExitFnForTests(spy)`, and asserts the spy fires once and the logger received `runtime.fatal { reason: "bus-strict-consumer-failed", … }`.

## 10. Archive readiness

- [x] 10.1 Run `pnpm exec openspec archive fix-silent-bus-consumer-failures` once the change is merged and deployed. Spec deltas in this change merge into the canonical specs; the change directory moves to `openspec/changes/archive/2026-04-26-fix-silent-bus-consumer-failures`.
