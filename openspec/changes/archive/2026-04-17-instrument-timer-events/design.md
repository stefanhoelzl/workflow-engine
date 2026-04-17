## Context

The sandbox package already emits fine-grained `InvocationEvent`s for nearly every host-guest interaction — triggers (`trigger.request` / `.response` / `.error`), action calls (`action.*`), and system bridges like `console` and `__hostFetch` (`system.*`). These events flow from the worker via a sink → `persistence` writes `pending/{id}/{seq}.json` → on the terminal trigger event, an archive file is flushed at `archive/{id}.json` and the DuckDB event store indexes the stream.

Timers are the lone guest-visible surface that bypasses this machinery. `globals.ts:34-39` explicitly rationalised the omission as "guest timer use is rare" and noted that `b.sync` / `b.async` wrappers cannot represent the `(callback, delay)` argument shape. That reasoning is partially wrong: the bridge already exposes the primitives needed to emit events manually (`b.emit`, `b.nextSeq`, `b.currentRef`, `b.pushRef`, `b.popRef`, and the private `buildSystemEvent` helper). Only the wrapper sugar fails to fit — the substrate is fine.

The observable consequence today is that timer callbacks are indistinguishable from no-ops in the archive. A callback that schedules `ctx.emit(...)` leaves action events in the stream whose `ref` points back to the trigger's `seq` with no explanation of the intervening async step. Worse, `globals.ts:52` silently swallows any error thrown inside a callback — those errors are unrecoverable from the archive.

This change adds a `timer.*` event family and delivers it through the existing pipeline without adding consumers, storage paths, or UI surfaces.

## Goals / Non-Goals

**Goals:**
- Every `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, and auto-cleanup disposal produces an observable event in the archive.
- Callbacks are framed by `request` → `response` | `error` pairs, mirroring the existing three event families.
- Correlation between timer events is trivial via a single `timerId` field; no new index columns or seq-pointer payload fields.
- Nested events emitted inside a callback (actions, console, further timers) attach to the callback's `timer.request` as a stack-parent, so the archive reflects causal structure.
- The `ref = null` convention is generalised: it already identified `trigger.request` as system-initiated; it now uniformly identifies any root event (including `timer.request` and auto-cleanup `timer.clear`).
- No new sandbox globals, no new host-bridge surface, no schema migration.

**Non-Goals:**
- Host-side scheduler or durable timers that wake workflows outside an invocation. Node-level `setTimeout` is the only mechanism; callbacks cannot outlive the invocation that created them.
- UI surfacing of timer events. They are event-stream only in v1.
- Callback source capture (`callback.toString()`). Correlating "what did the code do" is deferred to consulting `workflowSha`.
- Changes to the logging consumer. Action and system events already stay out of structured logs; timer events follow the same rule.
- Rescuing callback errors into `trigger.error`. They remain non-fatal; `setInterval` continues firing after an errored tick.

## Decisions

### D1. New `timer.*` kind, not overloading `action.*`

Alternatives considered:
- Reuse `action.*` with synthetic names like `"setTimeout"`.
- Mixed: treat set/clear as `action.*` (synchronous host calls) and add only `timer.fire` as new.

Chosen: a new top-level `timer.*` kind with five members (`set`, `request`, `response`, `error`, `clear`).

Rationale: `action.*` encodes a synchronous request/response pair where the host returns a value immediately to the guest. `setTimeout` is a temporally-decoupled pairing (set now, fire later; one set can produce N fires for intervals). Forcing that into `action.*` would either fabricate responses that don't correspond to real returns, or leave fires orphaned without a clear schema slot. A new kind captures the semantics faithfully and keeps consumers' existing filters clean (`WHERE kind LIKE 'action.%'` stays meaningful).

### D2. `timerId` is the sole cross-temporal link

Alternatives considered:
- Overload `ref` on `timer.request` and `timer.clear` to point at the originating `timer.set`.seq (asymmetric with other kinds but tree-friendly).
- Add explicit `targetSetSeq` / `setRef` fields in each event's payload.

Chosen: every timer event carries `timerId` in `input`; correlation is by `timerId` alone.

Rationale: Node's timer ids are monotonic within a process and never reused while the timer is pending. Within a single invocation (the only scope that matters — `clearActive()` disposes everything on invocation end), `timerId` is unique across all `timer.set` events. A reader can filter by `timerId` to reconstruct any timer's lifecycle; DuckDB querying reaches into `input` via JSON extraction, which is cheap at event-stream scale. This frees `ref` to mean exactly one thing — the active stack parent — across every event kind. It also removes the asymmetry that would otherwise arise (explicit `clearTimeout` has a natural call-stack parent; `timer.request` does not, so two kinds would have had different `ref` conventions).

Risk: if the Node implementation changed such that timer ids could collide within an invocation, `timer.clear`'s target would become ambiguous. Mitigation: if this risk materialises, mint our own monotonic counter inside `globals.ts` at `timer.set` time and use that instead of the native id. The event schema stays the same; only the production site changes.

### D3. `ref = null` means "system-initiated"

The existing schema already uses `ref = null` for `trigger.request` — emitted when the runtime delivers a trigger, with no prior stack. This change generalises that convention:

- `trigger.request` — runtime delivered the trigger → `ref = null`
- `timer.request` — runtime fired the callback → `ref = null`
- `timer.clear` emitted by `clearActive()` at invocation end — runtime disposed the timer → `ref = null`
- All guest-originated events (including explicit `clearTimeout`) — `ref` = stack parent (possibly `null` only when no frame is active, which is never the case inside a running handler).

This uniform rule lets readers recognise system-originated roots by inspection of `ref` alone, without needing a separate discriminator field or per-kind table. It is not a new invariant — it is the existing `trigger.request` invariant extended consistently.

### D4. `timer.request` is a stack-root for its callback

When a `timer.request` fires, the bridge pushes its own `seq` onto the ref-stack for the duration of the callback. Any nested `action.request`, `system.request`, further `timer.set`, or console call emitted from within the callback gets `ref = timer.request.seq`.

Alternatives: orphan the callback's effects (`ref = null` for everything inside) or attribute them to the original trigger. Both lose causal structure. The first makes nested actions look like top-level events; the second is plain wrong (the trigger may have returned long ago when an interval tick fires).

This mirrors how `trigger.request` roots its own handler's tree today — the same primitive, applied to a new kind of root.

### D5. `clearActive()` ordering moves ahead of the terminal trigger event

Today (`worker.ts:462-486`):
```
try {
  payload = await callGuestFunction(...)
  if (payload.ok) emitTriggerEvent("trigger.response", ...)
  else           emitTriggerEvent("trigger.error", ...)
} catch {
  emitTriggerEvent("trigger.error", ...)
} finally {
  timers.clearActive()     // silent today
  ...
}
```

After this change:
```
try {
  payload = await callGuestFunction(...)
} catch (err) {
  payload = { ok: false, error: serializeError(err) }
} finally {
  timers.clearActive()     // emits timer.clear events
  emitTriggerEvent(payload.ok ? "trigger.response" : "trigger.error", ...)
  ...
}
```

Rationale: `persistence.ts:51-52` flushes `archive/{id}.json` on the terminal trigger event. Any event emitted after that flush is lost from the archive. To guarantee auto-cleanup clears land in the archive, we emit them first. A pleasant side effect: `trigger.response` now semantically means "all side effects of this invocation are resolved," including timer cleanup.

The error path is collapsed: instead of emitting `trigger.error` from two places (the happy path when `payload.ok === false`, and the `catch` block), we set `payload` in both branches and emit once after `clearActive()`.

### D6. Expose `buildEvent` on the `Bridge` interface

The bridge already has a private `buildSystemEvent(kind, seq, ref, method, extra)` at `bridge-factory.ts:219-251`. It is generic over `kind` — the "System" in its current name is historical, not structural. This change renames it to `buildEvent` and exposes it on the `Bridge` interface (`bridge-factory.ts:60-108`).

Alternative: construct events inline in `globals.ts` using `b.emit` + `b.getRunContext()`. Rejected because six emit sites in `globals.ts` would each duplicate the field-assembly logic (setting `id`, `workflow`, `workflowSha`, `ts`, conditional `input`/`output`/`error`). Centralising in the bridge keeps event construction in one place and removes the risk of divergence between the two emission paths.

### D7. `timer.error` is non-fatal

A callback that throws emits `timer.error` and does not propagate. `setInterval` continues firing afterwards.

Alternative considered: promote errors to `trigger.error`, failing the invocation when possible. Rejected because the trigger may already have returned by the time an interval tick errors — the invocation is effectively finalised, so promotion is either a no-op or a racy partial failure depending on timing. A non-fatal event is symmetric with "fire and forget" semantics (which is the only consistent story available) and answers the observability question without changing invocation outcomes.

## Risks / Trade-offs

- **Event volume for intervals** → Tracked, accepted. A 50 ms interval in a 5 s handler produces ~100 `timer.request`/`timer.response` pairs plus one `set` and one `clear`. Uniform instrumentation is preferred over schema-level deduping. Guests that abuse intervals already have a cost problem; the archive just reflects it honestly. Mitigation if this becomes operationally painful: add a logging-consumer-level rate limit on timer events, not a schema change.
- **`timerId` uniqueness is an implementation assumption** → Node's timer id is monotonic in practice but not part of its API contract. Mitigation: if uniqueness is ever violated (tests with mocked timers, non-Node runtimes), replace `numId` in `globals.ts` with a bridge-minted counter. The event schema is unaffected.
- **`ref` field now has a per-kind semantics rule** → For paired events (`trigger.response`, `action.response`, `timer.response` etc.) `ref` points to the request; for roots it is `null`; for guest-initiated side-effect events it is the active stack parent. This is the same rule that already applies — the addition is that `timer.request` becomes a new root, not an overloading.
- **Reordering `clearActive()` before the terminal trigger event** → The terminal trigger event is now emitted after a host-side cleanup pass. If `clearActive()` were to throw synchronously, the terminal event would be skipped. Mitigation: `clearActive()` is defensive and never throws in normal operation (it only walks the pending map and calls `clearTimeout` / `clearInterval` on each id). We keep it in a `try` block so an unexpected throw does not eat the terminal event.
- **Breaking change to event stream order** → No internal consumer today assumes `trigger.response` is strictly last. External consumers (if any exist) reading from the archive could be surprised if they iterate strictly sequentially. Documented as BREAKING in the proposal; no migration needed since the new order is strictly more truthful.

## Migration Plan

Pure in-process change; no persisted-schema migration, no data format evolution, no wire protocol change. Deployment is a routine app rollout. Existing archives remain readable — they simply will not contain `timer.*` events, but readers iterating the discriminated union fall through any unknown kind gracefully because the zod `.discriminatedUnion` rejects unknown kinds at parse time (so readers do need the new package version before reading archives written by new runtimes — normal monorepo versioning handles that).

No rollback concerns. Reverting the change reverts the event-emission behaviour; archives written in the meantime retain timer events which older code will reject on parse. In practice this only matters if we run new-code then old-code on the same storage — which is not a supported configuration.

## Open Questions

None blocking. Two items to verify during implementation:

1. Does `callbackHandle.toString()` in QuickJS actually return the function source? Not used by this change (we decided against source capture), but worth noting in case we revisit.
2. The QuickJS return-value marshalling path for `timer.response.output`: we use `vm.dump(ret)` which handles JSON-serialisable values. If a callback returns a non-serialisable value, we should fall through to recording `output: undefined` rather than throw. The implementation will need to guard this.
