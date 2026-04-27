## Context

The runtime's event bus fans out `InvocationEvent`s to three consumers in sequence: `persistence` (writes `pending/{id}/{seq}.json` and archives on terminal), `event-store` (DuckDB index for dashboard queries), `logging` (structured stdout per lifecycle event). Today the executor wires the sandbox's `onEvent` stream onto a per-sandbox emit-tail chain:

```
state.emitTail = state.emitTail.then(() =>
    bus.emit(widened).catch(() => {
        /* swallow consumer errors — they shouldn't block the next emit */
    }),
);
```

The `.catch(() => {})` was introduced to keep the chain alive after a failure (so seq=N+1 still gets a chance to emit), but it swallows *every* consumer failure with no log line. Concrete consequences when persistence's `backend.write` fails:

1. The event never lands in `pending/` → archive never written → recovery cannot replay it.
2. EventStore + logging never run for that event (sequential short-circuit inside `bus.emit`).
3. `runInvocationWith` awaits `state.emitTail`, which resolves cleanly (the `.catch` ate the rejection); the HTTP caller receives a successful response.
4. No log line, no metric, no signal. The "events committed before response" comment at `executor/index.ts:191` is a lie under failure.

The current `event-bus/spec.md` actually documents the correct contract ("`bus.emit` SHALL reject with the error") — the bug is that the executor violates that contract. The fix needs to (a) define what failure handling means *per consumer*, (b) make catastrophic failures observable and unrecoverable in-process, (c) keep best-effort observability working when a non-durability consumer hiccups.

Stakeholders: workflow runtime (executor + recovery + bus + persistence), operators (CrashLoopBackOff signal under storage outages), spec authors (contract tightening).

## Goals / Non-Goals

**Goals:**

- Eliminate the silent-swallow path. Every consumer failure produces a structured log line.
- Tier consumers by durability class. Persistence is strict (failures crash the process); event-store and logging are best-effort (failures log + continue).
- Preserve "best-effort consumer failure cannot block other consumers" — the original intent behind the swallow.
- Make persistence failures unrecoverable in-process: log `runtime.fatal`, exit non-zero, let K8s + recovery reconcile on restart.
- Keep the change spec-visible (`BusConsumer` shape changes) but workflow-author-invisible (no surface delta).
- Tests can swap the exit hook so the test process does not actually die.
- **The bus owns the strict-consumer fatal-exit contract.** Callers do not need to know that strict means fatal — they just call `bus.emit`. Encapsulation: the durability-tier knowledge lives where the tier flag is read.

**Non-Goals:**

- Adding sandbox-level run cancellation (`run({ signal })`). The current `dispose()` is sufficient because the process is dying.
- Backpressure / retry on transient storage failures. K8s `CrashLoopBackOff` *is* the retry mechanism; per-event retry inside the bus is out of scope.
- A separate `runtime.fatal` reason per call site (live-traffic vs boot-time recovery). The bus owns the single reason `"bus-strict-consumer-failed"`; the calling site is implicit in the surrounding log/process state (recovery runs before the HTTP port binds; live invocations have widened-event context like `owner` and `workflowSha` already present in the `runtime.fatal` log line).
- Changing the order in which consumers run inside `bus.emit` (still `[persistence, eventStore, logging]` per `main.ts`).
- A new error class. The `systemShutdown` *function* throws nothing observable in production (the process dies before any exception reaches a caller); the contract lives in the function, not in a class.

## Decisions

### Decision 1 — Tier consumers via a `strict` field on the `BusConsumer` interface

Add `readonly name: string` and `readonly strict: boolean` to `BusConsumer`. Persistence sets `strict: true`; event-store and logging set `strict: false`.

**Why this over alternatives:**

- *Wiring-time argument in `createEventBus`* (e.g. `createEventBus([{ consumer, strict }, …])`). Rejected: the strict-vs-best-effort distinction is a property of the consumer (durability boundary or not), not of the wiring site. Every wiring would have to agree on which is which; co-locating with the consumer is self-documenting.
- *Discriminated union of `StrictConsumer` | `BestEffortConsumer`*. Rejected as overkill for a 1-bit distinction.
- *Hard-coded "persistence is strict" inside the bus*. Rejected: couples bus to a specific consumer identity; future durability-class consumers (e.g. compliance audit log) cannot opt in without bus changes.

### Decision 2 — Bus owns the strict-consumer fatal-exit contract

The bus runs per-consumer try/catch. On a thrown rejection:

- Log `bus.consumer-failed { consumer, error }`.
- If best-effort: continue to the next consumer; `emit` resolves normally after the last consumer.
- If strict: call `await systemShutdown(opts.logger, "bus-strict-consumer-failed", { consumer, id, kind, seq, owner, workflowSha, error })`. `systemShutdown` logs `runtime.fatal`, schedules `setImmediate(process.exit(1))`, and returns a `Promise<never>` that never resolves. Because the bus awaits it, `emit` itself never resolves — callers' `await bus.emit(...)` parks forever, matching the production semantics that no further work runs on a doomed process.

```
event-bus/index.ts (sketch)
─────────────────────────────────────────────────────────
async emit(event) {
    for (const consumer of consumers) {
        try {
            await consumer.handle(event);
        } catch (err) {
            const error = err instanceof Error
                ? { message: err.message, stack: err.stack }
                : { message: String(err) };
            opts.logger.error("bus.consumer-failed", {
                consumer: consumer.name,
                error,
            });
            if (consumer.strict) {
                await systemShutdown(opts.logger, "bus-strict-consumer-failed", {
                    consumer: consumer.name,
                    id: event.id,
                    kind: event.kind,
                    seq: event.seq,
                    owner: event.owner,
                    workflowSha: event.workflowSha,
                    error,
                });
            }
        }
    }
}
```

**Why bus-owned, not caller-owned:**

The earlier draft of this design had the bus rethrow on strict and required each caller (executor + recovery) to wrap with `.catch((err) => systemShutdown(...))`. That split a single piece of knowledge — *"strict means runtime-fatal"* — across two layers:

- The bus knows `consumer.strict`.
- Each caller has to know that `bus.emit` rejecting means "the strict consumer failed; that's fatal; call systemShutdown."

Any new caller of `bus.emit` has to relearn this. Forgetting silently violates the contract (returns to the silent-swallow bug we are fixing). Wrapping with a non-fatal handler silently violates it. Wrapping with a different reason string drifts the operator-facing log key. The contract is fragile precisely because it is split.

By moving `systemShutdown` *into* `bus.emit`, the contract becomes: *"calling `bus.emit` is safe; if a strict consumer fails, the runtime dies before this resolves."* Callers don't need to know strict tiers exist. They just call `emit`. The bus encapsulates "what strict means."

Trade-offs accepted by this move:

- The bus gains a process-control responsibility (calls `systemShutdown`). In practice the bus already is a process-bound singleton wired by `main.ts`; there is no general-purpose reuse to protect. Tests inject `setExitFnForTests` once at the test-file level and assert on the spy.
- The `runtime.fatal` log loses the per-call-site reason discriminator (no more `recovery-emit-failed` distinct from `bus-strict-consumer-failed`). Recovery-vs-live can still be distinguished from process state (recovery runs before HTTP port binds) and from log-line shape (live-traffic events carry full widened context; recovery's replayed events do too because they were widened on first emission). Net loss: zero useful information.

### Decision 3 — `systemShutdown` is an async function, not a class

A `SystemShutdown` Error class with `setImmediate(exit)` in its constructor was considered. We rejected that in favour of a function that combines logging + exit-scheduling + halt:

```
packages/runtime/src/system-shutdown.ts
─────────────────────────────────────────────────────────
let exitFn: () => void = () => process.exit(1);

function setExitFnForTests(fn: () => void): void {
    exitFn = fn;
}

async function systemShutdown(
    logger: Logger,
    reason: string,
    context: Record<string, unknown>,
): Promise<never> {
    logger.error("runtime.fatal", { reason, ...context });
    await new Promise<never>((_resolve) => {
        setImmediate(() => exitFn());
    });
    // Unreachable. In production exitFn() terminates the process before
    // any resolver fires; in tests where exitFn is a spy, the surrounding
    // never-resolved Promise parks the caller forever.
    throw new Error("unreachable");
}
```

**Why a function, not a class:**

- A function returning `Promise<never>` carries the "won't return" signal in the type. Callers don't need a `try/catch`; they just `await` the call.
- Classes invite construction sites that don't intend to crash (e.g. test fixtures, type-only imports). A function is unambiguous: calling it *is* the shutdown.
- One module-level `exitFn` swap (`setExitFnForTests`) is simpler than a class with a static override.

**Why `setImmediate` and not synchronous `exitFn()`:**

- `process.exit(1)` is immediate; pino-style buffered loggers may not flush their last line before the process dies. `setImmediate` lets the current microtask queue drain (Hono can flush its 5xx, logger flushes stdout) before the kill.

**Why the never-resolving Promise:**

- The `await new Promise(() => …)` parks the caller forever. In production, `exitFn()` fires inside `setImmediate` and kills the process before resolution can happen. In tests with a spy `exitFn`, the await stays pending — same semantics as the production process being dead.
- This means the bus's `emit` never resolves after a strict failure, callers awaiting `bus.emit` never resolve either, and no further work runs on the doomed process. The chain is "stopped" without an explicit `dead` flag.

### Decision 4 — Persistence's existing graduated failure handling is preserved

Persistence already distinguishes catastrophic failures (pending-write throws) from soft failures (archive-write logs + continues, removePrefix logs + continues). The strict-tier flag interacts cleanly: only the throwing paths reach the bus's strict-consumer fatal-exit. We make the implicit contract explicit by adding a scenario covering the pending-write-throws path; the existing "archive write failure leaves pending and accumulator intact" scenario is unchanged.

### Decision 5 — Cross-spec story: bus is the single source of truth

```
            persistence ──────► declares strict: true
                 │
                 │
                 ▼
        event-bus ──► strict throw → log + systemShutdown
                          │
                          ▼
                 (process exits; K8s restarts)
                          │
                          ▼
                  recovery on next boot ──► reconciles
                                             orphan pending/
```

Operators traverse via the `runtime.fatal` log key (named in event-bus spec) and the `bus.consumer-failed` log key (named in event-bus spec). No aggregator capability; no `system-shutdown/spec.md`. The `systemShutdown` function is an implementation detail. The executor and recovery specs are NOT modified — they call `bus.emit`, the bus handles strict failures, and the executor/recovery contracts remain about forwarding events and replaying pending events respectively.

## Risks / Trade-offs

- **[Risk] Crash storms under chronic storage outage.** A failing storage backend means every invocation crashes the pod; K8s `CrashLoopBackOff` will eventually pause restarts, taking the runtime out of service. → **Mitigation:** This is the correct failure mode. Silent data corruption is strictly worse. Operators monitor `runtime.fatal` log lines and `Pod` restart counts. The exponential backoff K8s applies prevents thundering-herd against the storage backend during recovery.

- **[Risk] In-flight HTTP request loses its response.** When the bus crashes mid-emit, the HTTP source's `await entry.fire(...)` is parked (the executor's `await state.emitTail` never resolves). The connection drops when the process dies. → **Mitigation:** This is acceptable. The client sees a connection reset (or 502 from the load balancer) which is the canonical "transient runtime failure, retry" signal. The alternative (silent ok with corrupted state) is worse.

- **[Risk] `setImmediate` does not actually flush all logger buffers.** If pino is configured with a high-watermark write stream, one tick may be insufficient. → **Mitigation:** The runtime's pino setup writes synchronously to stdout (no transport, no buffering). `setImmediate` is sufficient. If transport buffering is added later, `systemShutdown` should switch to `logger.flush()` + setImmediate.

- **[Risk] `setExitFnForTests` is module-level state — leaks between tests.** Forgetting to reset it in `afterEach` could let one test's spy leak into the next. → **Mitigation:** Vitest's per-file isolation contains the leak; in-file leaks are caught by the test for `system-shutdown` itself, which uses `beforeEach`/`afterEach` and drains pending `setImmediate` callbacks before resetting. The tests for executor and recovery follow the same pattern.

- **[Risk] Recovery crash loop on persistent storage failure.** If persistence is broken at boot, `recover()` calls `bus.emit`, the bus calls `systemShutdown`, the pod crashes, K8s restarts, recovery crashes again. → **Mitigation:** This is the correct fail-fast behaviour. K8s's `CrashLoopBackOff` is the operator's signal to fix the storage backend. Without this, the runtime would silently start serving traffic with an empty event store while pending state on disk grows unbounded.

- **[Trade-off] Per-event log volume increases.** Best-effort consumer failures now emit `bus.consumer-failed` lines; previously they were silent. → **Acceptable.** That is the entire point of the change. If logging-consumer itself starts failing on every event, the resulting `bus.consumer-failed` cascade is a real signal that needs operator attention, not log-volume noise to suppress.

- **[Trade-off] Bus is now a process-control component.** It can `process.exit` the runtime. → **Acceptable.** The bus is wired exactly once at runtime startup (`main.ts`); there are no general-purpose reusers. Tests use `setExitFnForTests` to swap the exit hook. The encapsulation gain (callers don't need to know that strict means fatal) outweighs the coupling cost (bus tests need to swap the exit hook).
