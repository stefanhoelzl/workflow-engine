## Context

The QuickJS sandbox today places three responsibilities in the worker thread that are conceptually main-side concerns: the `seq` counter, the ref-stack (frame parent-pointer mechanism), and the runActive gate that suppresses pre/post-run emissions. Each invocation event flows worker → main fully stamped (`{kind, seq, ref, ts, at, name, …}`); main passes it through to the bus.

This split surfaces concrete pain whenever main needs to write an event without the worker's involvement:

- **Limit-breach synthesis** (the in-flight `sandbox-resource-limits` change). Main decides to terminate the worker for OOM or timeout; the run never gets its terminal `trigger.error`. To synthesise it, main fabricates seq via a `lastSeenSeq + 1` mirror — correct but a wart.
- **Future main-side event injection** (rate-limit warnings, soft-kill notices, debug markers). Each new use case re-derives the same workaround.

A secondary pain spread across `bridge-factory.ts`, `sandbox-context.ts`, `plugin-runtime.ts`, and `worker.ts`: framing/stack bookkeeping (`pushRef`/`popRef`/`refStackDepth`/`truncateRefStackTo`/`FrameTracker`/`bridgeFrameTracker`/`truncateFinalRefStack`) is duplicated across layers, with the bridge holding stack state that lifecycle hooks reach into via a tracker abstraction. Moving the ref-stack to main collapses this.

Constraints:

- The bus contract — what `sb.onEvent` delivers to the Executor and what flows through Persistence / EventStore / Dashboard / LoggingConsumer — must not change. Existing event archives must remain valid.
- Workflow author API (`ctx.emit`, `ctx.request`, the workflow `defineWorkflow` surface) shape can break, but workflow source code that doesn't manually emit events must keep working unchanged.
- Recovery's cold-start synthesis (process restart, persisted invocation has no live worker) is structurally different — there is no live `RunSequencer` to consult — and is explicitly out of scope.
- Pre-existing concurrent-frame-stack semantics (Promise.all sibling-open parent attribution at OPEN time) is acknowledged as wrong but not fixed by this refactor; declared non-goal.

## Goals / Non-Goals

**Goals:**
- Sandbox (main thread) owns the entire sequencer: `seq` counter, refStack, callId→openSeq map, runActive gate.
- Worker → main wire event drops `seq` and `ref`; carries `{kind, name, ts, at, input?, output?, error?, type}` where `type: "leaf" | { open: CallId } | { close: CallId }` is an explicit, typed framing discriminator. The kind string is free-form metadata and is **not** parsed for framing.
- Sandbox stamps `seq` / `ref` from the explicit `type` field plus the embedded callId — no kind-suffix derivation.
- Sandbox auto-synthesises closes for any frames still open when worker death is observed — no public `synthesise()` API exposed to callers.
- SDK `ctx.emit` reshapes to `(kind, options)` with the framing in `options.type`. `EmitOptions` carries `{name, input?, output?, error?, type?}` where `type?: "leaf" | "open" | { close: CallId }` and defaults to `"leaf"`. The previous `EmitOptions` (`createsFrame` / `closesFrame` flags) is removed.
- Reserved event-prefix list shrinks from 9 to 3 (`trigger`, `action`, `system`); host calls (fetch, mail, sql, setTimeout, console.log, randomUUID, …) flow under `system.*` with `name` disambiguator.
- `uncaught-error` becomes `system.exception`.
- Out-of-window events (worker emits while runActive=false) route to the host `Logger`, not to the bus.
- Bus-side `SandboxEvent` shape (boundary 3) preserved bit-for-bit. `callId` dropped at the Sandbox boundary.

**Non-Goals:**
- Recovery's cold-start synthesis — separate path, stays as-is.
- Promise.all sibling-open parent attribution bug — declared non-goal; refactor relocates already-correct close-side ref attribution but the open-side bug remains.
- Persistence / EventStore / DuckDB schema change — none required; bus events unchanged.
- Workflow author API change beyond what the renaming forces.

## Decisions

### D1. Sandbox owns the sequencer; no external `synthesise()` API

Initial design considered exposing `sb.synthesise(...)` so the executor could inject limit-breach terminals. Rejected. Sandbox already observes worker death (`worker.on("error")` / `worker.on("exit")` → `onDied`). It also tracks open frames (callMap). It has the sequencer. So Sandbox can synthesise the closing event itself, internally, and route through `onEvent` like any other event.

For limit-breach: the limit monitor either lives inside Sandbox (cleanest) or the Executor calls a `Sandbox.terminate(reason)` API and Sandbox does the synthesis. Either way, the sequencer never escapes Sandbox.

**Alternatives considered:**
- `synthesise()` on the public `Sandbox` interface → leaks the sequencer concept; raises "guest can never reach this" enforcement question.
- Separate `SandboxLifecycle` / `SandboxHostOps` interface → adds a type, more plumbing, no real benefit over keeping it internal.
- Both rejected in favour of "sequencer is fully encapsulated; Sandbox auto-closes on death."

### D2. Framing is explicit via a typed `type` field; kind is free-form

The framing of an event (leaf, open, close) is a structural property of the event. Encoding it via a string suffix on the kind would couple the worker's stamping logic to a free-form metadata field, allow silent typo footguns (`trigger.requestt` becomes a leaf with no error), and require every consumer to re-parse the same convention.

Instead, every wire event carries a typed `type` discriminator: `"leaf" | { open: CallId } | { close: CallId }`. Sandbox reads this directly — no string parsing, no kind-suffix derivation. The kind string is free-form metadata: it carries semantic meaning for downstream consumers (dashboards, logging filters) but plays no role in the worker's stamping or main's framing logic.

The structural design of the discriminator is the key insight: `{ close: CallId }` makes it impossible to express "close" without specifying *what* is being closed. The pair token is intrinsic to the close, not a sibling argument that might get forgotten — type-system-enforced pairing.

**Alternatives considered:**
- **Suffix derivation** (`*.request` → open, `*.response`|`*.error` → close, else leaf): hides framing inside a string convention, silently broken by typos, requires every layer to re-parse the same convention. Rejected.
- **Open enum string `framing: "open" | "close" | "leaf"`** with separate `callId` field for closes: explicit but doesn't structurally enforce that closes have callIds. A caller can pass `framing: "close"` and forget the callId; runtime drops the event with a log, but the bug compiles. Rejected in favour of the tagged union.
- **Three dedicated SDK methods** (`emit`/`openFrame`/`closeFrame`): clean separation but grows the SDK surface and breaks symmetry with `ctx.request`. Rejected — the tagged union gives the same enforcement with one verb.

`*.request` / `*.response` / `*.error` survives as a downstream **convention** for kinds (the `system.*` family, the trigger plugin, the action plugin all follow it), but the convention is decorative — dashboards and logging filters use it freely, while the worker-to-main framing pipeline ignores it.

**Death-path synthesis kind derivation.** When the worker dies and Sandbox synthesises closes for the still-open frames, it must produce a `kind` for each synthetic close event. The rule: take the captured open-kind's prefix up to (but not including) the first `.` and append `.error`. So `"system.request"` → `"system.error"`, `"trigger.request"` → `"trigger.error"`, `"weird-no-dot"` → `"weird-no-dot.error"`. This rule is failsafe: it works regardless of whether the open's suffix followed the `.request` convention, and a typo in the open's suffix (e.g. `.requestt`) doesn't break synthesis. It also preserves prefix grouping at the bus boundary, so `system.*` opens always synthesise to `system.error` regardless of which name disambiguator they carried. By construction, every entry on the refStack/callMap arrived via `type: "open"`, so the synthesis rule applies uniformly to all stack entries — there is no "what if this isn't a paired frame?" edge case.

### D3. `ctx.emit(kind, options)` and `ctx.request(prefix, options, fn)` — symmetric options-bag shape

The SDK exposes two methods with parallel shape:

```ts
type EmitOptions = {
  name: string                                      // required
  input?: unknown
  output?: unknown
  error?: SerializedError
  type?: "leaf" | "open" | { close: CallId }        // default "leaf"
}

type RequestOptions = {
  name: string                                      // required
  input?: unknown
}

interface SandboxContext {
  emit(kind: string, options: EmitOptions): CallId
  request<T>(
    prefix: string,
    options: RequestOptions,
    fn: () => T | Promise<T>,
  ): T | Promise<T>
}
```

Every `emit` returns a `CallId` (the assigned id on opens; an opaque value on leaves and closes that callers ignore). Type defaults to `"leaf"`, so the common case (`ctx.emit("system.call", { name, input })`) reads cleanly without ceremony. Opens and closes are always written explicitly:

```ts
const callId = ctx.emit("trigger.request", { name, input, type: "open" })
// later:
ctx.emit("trigger.response", { name, input, output, type: { close: callId } })
```

The `{ close: callId }` form means a close cannot exist as a value without its pair token — the failure mode "forgot to pass callId" is a type error, not a runtime drop.

`ctx.request` shares `(string, options-bag)` opener with `ctx.emit`, then takes the wrapped work as a trailing positional arg in the JS-idiomatic "callback last" position.

**Alternatives considered:**
- **Positional `(kind, name, extra, callId?)`**: doesn't structurally enforce close-needs-callId. Rejected.
- **TypeScript overloads narrowing on kind suffix**: enforcement is partial (ignored return values, dynamic kind strings slip through). Rejected.
- **Required `type` (no leaf default)**: maximally explicit, but every leaf call site (`console.log`, `randomUUID`, `performance.mark`) gets a noisy `type: "leaf"`. Default-to-leaf is safe under E because the only dangerous direction (forgetting framing on a close) is structurally impossible — you cannot write `type: { close }` without the callId. Default chosen.
- **`name` positional vs in options bag**: putting `name` in the bag (`{ name: "console.log", … }`) makes the call site self-documenting (it's clear what the string means) and uniform with `input`/`output`/`error`. Positional `name` was rejected — `ctx.emit("trigger", "hallo", …)` is less clear than `ctx.emit("trigger", { name: "hallo", … })`.
- **`fn` inside `request`'s options bag** vs trailing positional: putting fn last as positional matches the JS "callback last" idiom and signals "this is the work being wrapped." `request` always has options (at least `name` is required), so `(prefix, options, fn)` reads symmetric-with-emit-plus-fn rather than diverging.

### D3a. Asymmetric SDK-input vs wire-format types for framing

The SDK accepts `type: "open"` from the caller (the caller does not yet have a CallId — the bridge will mint one). The bridge rewrites to `type: { open: <assignedCallId> }` on the wire, mirroring the close shape.

```ts
// SDK input (caller-facing):
type EmitFraming = "leaf" | "open" | { close: CallId }

// Wire / sequencer input (after bridge assignment):
type WireFraming = "leaf" | { open: CallId } | { close: CallId }
```

The asymmetry is a one-line transformation in the bridge: `if (type === "open") { wire.type = { open: bridge.nextCallId() } }`. The SDK returns the assigned CallId from `emit` so the caller can pair a future close.

This buys: SDK callers don't deal with id assignment; main-side sequencer reads a uniform tagged union with id always present on framed events; closes are structurally enforced at both API and wire boundaries.

### D4. RunSequencer lifecycle: `start()` / `next()` / `finish(opts?)`

Three methods, all internal:

- `start()` — opens the window: `runActive=true`. State (seq=0, refStack=[], callMap={}) is already zero from prior `finish` (or initial construction); no zeroing here.
- `next(wireEvent)` — stamp seq+ref, update refStack/callMap by kind suffix, return widened SandboxEvent.
- `finish(opts?: { closeReason })` — close the window: synthesise close events for any open frames if `closeReason` is provided (worker death path), else log `sandbox.dangling_frame` warning if frames are open (plugin-bug path); zero state; runActive=false.

**Alternatives considered:**
- `reset()` at run start AND `finish()` at run end (two operations) → fake symmetry; the actual heavy work is in finish, and `reset` mostly does nothing. Rejected.
- `reset()` only at run start; sequencer state lingers between runs → leaves "frozen post-run state" mental overhead; no caller reads it (sequencer is fully encapsulated). Rejected.
- `finish()` at run end (chosen) → cleanup at the end where Sandbox is already doing work (death-synthesis, refStack cleanup); next `start()` just opens the window. Symmetric with construction.

The `closeReason`-or-warn branching in `finish` unifies today's `truncateFinalRefStack` + `logDanglingFrame` (plugin-runtime.ts:354) with death-synthesis under one method.

### D5. Out-of-window events go to the host Logger, not the bus

Worker keeps a `runActive` gate inside `bridge.buildEvent` (mirroring pre-refactor) that suppresses emissions outside an active run window. `setRunActive()` opens the window at run start (also resets the per-run callId counter); `clearRunActive()` closes it at run end. Emissions during init phases (Phase-4 user-source eval — including inlined WPT test bodies that synchronously invoke `console.log(Symbol.for(...))`) and during the post-`done` restore window are silently dropped at the source — never reaching `port.postMessage`.

This worker-side gate is **load-bearing**, not redundant with the main-side `RunSequencer`'s gate: structured-clone of values like `Symbol.for(...)` (registered symbols cross `vm.dump` as host primitives) throws `DataCloneError` synchronously inside `port.postMessage`, before main can even receive the event. Suppressing at the source is the only way to keep host-callback paths (e.g. `console.log`) from raising clone failures back into guest code. The main-side `RunSequencer` retains its own `runActive` for stamping ordering; both gates are required.

Sandbox's main-side `RunSequencer` additionally logs any wire event arriving while *its* `runActive=false` as `sandbox.event_outside_run` (defence-in-depth diagnostic for late guest-async resolutions that slipped past the worker gate's race window with restore).

### D6. `callId` is worker-scoped; never leaves Sandbox

Worker assigns `callId` via a local counter on opens. Closes echo it. Sandbox uses it for ref pairing (callId → openSeq lookup). After stamping `ref`, callId has done its job and is dropped. The Executor never sees callId.

This preserves the existing bus contract (no new field on `SandboxEvent`) and avoids leaking worker-internal state to consumers.

### D7. Reserved event-prefix consolidation: 9 → 3

`trigger`, `action`, `system`. All host calls (today: fetch, mail, sql, timer, console, wasi, randomUUID, performance.mark, …) flow under `system.*` with `name` disambiguator. Five `system.*` sub-kinds:

| Kind | Pairing | Meaning |
|------|---------|---------|
| `system.request` | open | host call started |
| `system.response` | close (success) | host call returned |
| `system.error` | close (failure) | host call failed |
| `system.call` | leaf | fire-and-forget host call (`console.log`, `randomUUID`, `performance.mark`) |
| `system.exception` | leaf | guest had unhandled throw, bubbled via `reportError` (replaces `uncaught-error`) |

`trigger.*` and `action.*` retain their `request|response|error` triplets — they represent workflow-domain concepts (workflow boundary, cross-action calls), not platform host calls.

`system.error` (host call failed, paired) vs `system.exception` (guest threw, leaf) is a real distinction worth advertising at the bus level — different debugging implications and shapes (error has callId; exception is unparented).

**Alternatives considered:**
- Keep `uncaught-error` distinct → preserves "this is exceptional, not a normal call" framing. Rejected for consistency.
- Fold exception into `system.call` with `name="uncaught-error"` → loses the "this is an exception" signal at the kind level. Rejected.
- `system.exception` as its own sub-kind → genuine semantic distinction, suffix rule still works (`.exception` falls through to leaf). Chosen.

### D8. Concurrency model: single-threaded by construction

Sequencer state is mutated only inside the main-thread `worker.on("message")` handler. JS single-threaded execution gives mutex semantics for free; no locks or atomics. Worker postMessage is FIFO; main processes serially; stamp order = emit order = bus delivery order. Death observation (`worker.on("error")` / `worker.on("exit")`) is queued on the same event loop — all in-flight events drain before death is observed.

If `sequencer.next()` throws (defensive — should never), the error is caught, logged via `logger.error("sandbox.stamp_failed", {...})`, and the event is dropped. The handler must never crash.

Trade-off: forecloses off-thread parallelization of stamping. Not a real constraint at workflow-engine volume.

## Sequence diagrams

### Happy path: trigger → fetch → response

```
Guest      Worker (bridge)        Sandbox (main)         Executor
  │              │                      │                    │
  │ ctx.emit("trigger.request", {name, input, type:"open"})
  │─────────────▶│ assign callId=1     │                    │
  │              │ post WireEvent(kind="trigger.request", type:{open:1}, …)
  │              │─────────────────────▶│ seq=0, ref=null
  │              │                      │ refStack.push(0); callMap[1]={openSeq:0,…}
  │              │                      │ onEvent(SandboxEvent(seq=0, ref=null, …))
  │              │                      │───────────────────▶│
  │ ctx.emit("system.request", {name:"fetch", input, type:"open"})
  │─────────────▶│ assign callId=2     │
  │              │ post WireEvent(kind="system.request", type:{open:2}, …)
  │              │─────────────────────▶│ seq=1, ref=0; refStack.push(1); callMap[2]
  │              │                      │───────────────────▶│
  │ … fetch resolves …                  │                    │
  │ ctx.emit("system.response", {name:"fetch", output, type:{close:2}})
  │─────────────▶│                      │
  │              │ post WireEvent(kind="system.response", type:{close:2}, …)
  │              │─────────────────────▶│ entry=callMap[2]; ref=1
  │              │                      │ refStack remove 1; callMap.delete(2)
  │              │                      │───────────────────▶│
  │ ctx.emit("trigger.response", {name, output, type:{close:1}})
  │─────────────▶│                      │
  │              │─────────────────────▶│ ref=0; refStack remove 0; callMap.delete(1)
  │              │                      │───────────────────▶│
  │              │ post {type:"done"}   │
  │              │─────────────────────▶│ sequencer.finish() → state already empty, just runActive=false
```

### Death path: worker dies during fetch B

```
Guest      Worker                Sandbox                Executor
  │ trigger.request, fetch A.req/res, fetch B.req emitted normally
  │              │ (worker dies; OOM)   │
  │              │─── exit/error ──────▶│
  │                                     │ Observed via onDied
  │                                     │ sequencer.finish({closeReason:"worker terminated: …"})
  │                                     │   walk callMap LIFO: [trigger@0, fetch.B@3]
  │                                     │   synthesise system.error(seq=4, ref=3, name="fetch", error=…)
  │                                     │───────────────────▶│
  │                                     │   synthesise trigger.error(seq=5, ref=0, name=…, error=…)
  │                                     │───────────────────▶│
  │                                     │ zero state; runActive=false
```

## Risks / Trade-offs

- **[Coordinated breaking change across many call sites]** → Mitigation: single PR. Worker, Sandbox, SDK, runtime plugins (trigger.ts, fetch/mail/sql/timer/console plugins in `sandbox-stdlib`), kind-matching consumers (logging-consumer, flamegraph), reserved-prefix list (CLAUDE.md, SECURITY.md §2 R-7) ship together. Test at each boundary: bridge-factory.test.ts, sandbox.test.ts, sandbox-context.test.ts, plugin-runtime.test.ts, recovery integration tests, and the WPT suite (sensitive to event volume and shape).
- **[Pre-existing concurrent open parent-attribution bug stays]** → Mitigation: declared non-goal; documented in design.md and recovery spec. Fix sketched as future work (capture ref at open from a logical-parent context, not stack top).
- **[`callId` on the wire is just a number — could collide if worker counter wraps]** → Mitigation: use a per-run counter that resets on `start()`. Number.MAX_SAFE_INTEGER is far beyond any realistic per-run event volume.
- **[Synthetic close events use last-seen `ts` and `at`]** → Preserves today's "limit-breach terminal reuses last-seen ts" rule. Documented; flamegraph/dashboard already render this case correctly.
- **[Out-of-window events log volume]** → If a misbehaving guest emits heavily during the restore window, logger volume could spike. Mitigation: log at `warn` level so volume can be filtered; no behavioural impact on the run.
- **[Stamping latency in main-thread handler]** → Counter++ + Map ops; negligible. WPT suite is the load test (high event volume).
- **[Tests that assert on wire format]** → Will need updating. `bridge-factory.test.ts` asserts on `nextSeq` / `pushRef` / `popRef`; `sandbox-context.test.ts` asserts `createsFrame` / `closesFrame` push/pop; `plugin-runtime.test.ts` asserts `FrameTracker` truncation. All move or delete.

## Migration Plan

Single coordinated change; no incremental rollout possible (wire shape is breaking). Steps:

1. **Add `RunSequencer` on main** with `start()` / `next()` / `finish()` API. Pure module, unit-tested in isolation. Sandbox does not yet use it.
2. **Update wire types in `protocol.ts`** — add `WireEvent` type alongside the existing `event` message; mark new shape.
3. **Switch worker `bridge.buildEvent`** to produce `WireEvent` (drop seq/ref/runActive gate at source). `sandbox-context.ts` updates: `pluginEmit` posts WireEvent; `pluginRequest` captures callId in closure; `emitRequest`/`emitResponse`/`emitError` collapse.
4. **Switch Sandbox `onPersistentMessage`** to call `sequencer.next(wireEvent)` and forward the stamped SandboxEvent. Drop `dispatchEvent`'s passthrough.
5. **Wire up `sandbox.run()`** to call `sequencer.start()` / `sequencer.finish()` and the death-path synthesis.
6. **Strip removed primitives** from `bridge-factory.ts`, `plugin-runtime.ts`, `worker.ts`, `sandbox-context.ts`. Tests that referenced them delete or rewrite.
7. **Drop `EmitOptions`** from `plugin.ts` SDK type. Update `trigger` plugin in `packages/runtime/src/plugins/trigger.ts` to capture callId between hooks.
8. **Migrate kind-emitting plugins** in `sandbox-stdlib`: fetch/mail/sql/timers/console all emit under `system.*` with `name` field. `__reportErrorHost` emits `system.exception`.
9. **Update kind-matching consumers**: `logging-consumer/spec.md` filter rules, `flamegraph.ts` glyph mapping, `dashboard-list-view/spec.md` "Bar visual treatment by kind and status".
10. **Update `SECURITY.md`** §2 R-7 reserved-prefix list (9 → 3) and §2 R-8 stamping-boundary text (split: ts/at/kind/name worker-stamped; seq/ref Sandbox-stamped). Update `CLAUDE.md` mirror of R-7 and `## Upgrade notes`.
11. **Run full validation**: `pnpm validate` (lint + check + test), `pnpm test:wpt` (WPT suite is the high-volume load test for stamping correctness), `pnpm dev` probe of `workflows/src/demo.ts` (every reserved-prefix kind exercised end-to-end).

**Rollback**: revert the single PR. No persistence schema changes; existing event archives remain valid (their kinds match the post-refactor consumer rules in the rollback direction trivially since the Sandbox just re-derives framing from the same kinds).

## Open Questions

(none remaining at proposal time — all four originally surfaced questions resolved during scoping.)
