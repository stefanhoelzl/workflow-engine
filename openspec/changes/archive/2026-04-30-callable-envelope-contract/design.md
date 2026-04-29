## Context

The QuickJS sandbox bridges guest VM code to host plugin code through `Callable` — a host-side wrapper around a guest `JSValueHandle` that lets host plugins re-invoke guest functions after the originating descriptor call has returned (timer callbacks, SDK action handlers, future async-callback plugins). `makeCallable` lives in `packages/sandbox/src/bridge.ts:436`; the type lives in the same file. There are exactly two in-tree consumers today:

1. `packages/sandbox-stdlib/src/timers/index.ts:fire()` — invoked when a Node `setTimeout` / `setInterval` fires. Wraps `entry.callable()` inside `ctx.request("system", …, () => entry.callable())` and discards the returned promise (fire-and-forget under a request frame).
2. `packages/sdk/src/sdk-support/index.ts:135` (`__sdk.dispatchAction`) — runs inside the sandbox bridge's `buildHandler` closure, awaits the guest action handler via `await handler(input)`, runs `validateActionOutput`, and disposes in `finally`.

The current `Callable.invoke` rejects when the guest throws — the rejection is constructed in `awaitGuestResult` and (post-F-2) carries a `GuestThrownError` whose `.name` / `.message` / guest-side `.stack` / structured own-properties are curated. F-2 closed the symmetric host→guest leak: errors thrown host-side and surfaced to the guest VM are now sanitised by `sanitizeForGuest` before crossing the trampoline (`SECURITY.md` §2 R-12; `openspec/specs/sandbox/spec.md` "Host/sandbox boundary opacity for thrown errors").

The asymmetry: F-2 closed the host→guest leak; the guest→host escape is still open. When a guest throws inside a Callable that is fired from a deferred Node task (timers' `fire()`):

```
   1. Node setTimeout fires the registered host callback.
   2. fire() calls ctx.request("system", …, () => entry.callable()).
      - pluginRequest emits system.request open.
      - pluginRequest enters .then() on the callable's invoke promise (P0).
      - This creates chained promise P1 = P0.then(_, errFn).
   3. callable.invoke() awaits awaitGuestResult, which rejects with
      GuestThrownError when the guest throws.
   4. P0 rejects with GuestThrownError.
   5. P1's err handler runs: emits system.error close, rethrows.
   6. P1 rejects (rethrown).
   7. fire() discarded P1 — nobody observes the rejection.
   8. Node's unhandledRejection escalates → worker terminates.
   9. Main observes worker exit → run rejects with "worker exited
      with code N", regardless of whether the handler had already
      resolved cleanly via `done`.
```

This is the F-3 finding. A hostile workflow author can deterministically force run-failure by deferring a throw past handler return: `setTimeout(() => { throw }, 0)` plus any async wait in the handler reproduces it 100%. The same pattern with `setInterval` flips every subsequent run that touches it.

The audit shape that *should* have surfaced — `system.request` open / `system.error` close on the timer's frame — is silently dropped along with every other in-flight event between the throw and the worker's restore boundary. Operators see a `kind:"crash"` worker termination, indistinguishable from a genuine engine bug.

This change closes the escape route at the architectural choke point: `Callable.invoke`'s rejection contract.

## Goals / Non-Goals

**Goals:**

- Guest-originated throws inside Callables never cause Node `unhandledRejection` escalation; the worker survives.
- The audit trail records guest throws under the host frame's `system.request` open as a `system.error` close, with the curated `GuestThrownError` shape (preserving F-2's structured own-property work).
- A handler that resolves cleanly produces a successful run, even if a deferred Callable throws after handler resolution and before worker restore.
- The contract change is enforced by the type system: out-of-tree consumers who upgrade get TS errors at every call site that treats `await callable()` as a raw `GuestValue`. No silent runtime change.
- Engine bugs (programming errors, vm-disposed-mid-call, marshal failures) continue to fail loud — they reject and (today) terminate the worker. F-3 does not silence engine-class signals.
- The fix is structurally inherited by future plugins that use `Guest.callable()` — no plugin-author opt-in, no R-4-checklist line about "remember to catch deferred Callable rejections."

**Non-Goals:**

- F-3 does not widen `serializeLifecycleError` (`packages/sandbox/src/plugin.ts:251`) to copy `GuestSafeError` own-properties for non-envelope error paths. The audit trail therefore continues to carry strictly less information for host-dispatcher errors (`FetchError`, `MailError`, `SqlError`) than what `sanitizeForGuest` propagates to the guest VM. This audit-trail symmetry gap is real, named in the proposal's `Out of scope`, and tracked as a follow-up that touches `trigger.ts:57`, host-call-action, and every host dispatcher.
- F-3 does not install any process-global `unhandledRejection` / `uncaughtException` handler. The team's F-2 work picked a "taxonomy + closure-rule at a named boundary" shape over a global trap; F-3 mirrors that.
- F-3 does not unify the two audit shapes for "uncaught guest throw." The web-platform `system.exception` leaf path (reportError / `__reportErrorHost`) and F-3's `system.error` close encode different facts and stay distinct (see `Decisions: Audit shape asymmetry`).
- F-3 does not change any wire shape on the bus. Persistence, EventStore, dashboard rendering all unaffected.
- F-3 does not change workflow-author surface. Callable is host-plugin-internal; the only author-visible effect is that `setTimeout(() => { throw })` no longer kills the run.

## Decisions

### Decision 1 — Envelope rewrite over worker-level `process.on` trap

The rejection-as-control-flow contract on `Callable.invoke` is the load-bearing source of the escape. Three mechanisms were considered to keep the worker alive on a deferred guest throw:

| Mechanism | Worker survives | Auto-protects future plugins | Engine-bug rejection still kills worker | Code change |
|---|---|---|---|---|
| Worker-level `process.on('unhandledRejection')` trap | ✓ all causes | ✓ all causes | ✗ (caught) | ~40 LoC, one file |
| `callable.fire()` opt-in API | only when used | only when used | ✓ | ~80 LoC across 2 files |
| **Envelope rewrite (chosen)** | ✓ guest-throw paths | ✓ via TS type | ✓ | ~150 LoC across 5 files |

The envelope rewrite was chosen because:

1. **Architectural consistency with F-2.** F-2 picked a typed-error taxonomy + named closure rule (`sanitizeForGuest`) over a global trap. The envelope rewrite mirrors that shape on the symmetric guest→host axis: a typed result envelope + a named auto-unwrap site (`pluginRequest`'s resolve handler). A global trap on the same package would be a different stylistic decision under the same umbrella, which is not what the team picked for F-2.

2. **Preserves engine-bug fail-loud.** A worker-level trap catches every cause of unhandled rejection, including programming errors. Today those errors kill the worker, which is the right signal — silencing them via a global trap would mute genuine engine bugs and conflate them with guest throws in the audit trail.

3. **Type-level enforcement.** The contract change is detectable by TypeScript: out-of-tree consumers who upgrade `@workflow-engine/sandbox` see TS errors at every `await callable()` site. No silent runtime drift; the failure tells the author exactly what to update.

4. **No process-global state.** Worker-level traps add a global handler that any other code in the worker (current or future) interacts with implicitly. The envelope rewrite is local to the bridge + pluginRequest pair.

The chained-rejection brittleness of a Callable-promise-registry approach (registering raw Callable invoke promises and detecting unhandled-rejection scope via WeakSet) was investigated and ruled out: `pluginRequest`'s `.then(_, errFn)` rethrow creates a chained promise (P1) whose rejection is what Node fires `unhandledRejection` on, not the registered ancestor (P0). JS promise chaining provides no API for "rejection observed by some sibling, do not propagate to chained promises."

### Decision 2 — Envelope shape: full `GuestThrownError` surface, not minimal

`CallableResult.error` carries `{ name: string, message: string, stack: string } & Record<string, unknown>` — preserving F-2's `ensureExtendedNewError` work that copies enumerable own-properties of host Errors onto guest exceptions. Plugin authors inspecting `result.error` see the same shape they had in the `catch` branch under the old contract: `.name` for class discrimination (`TypeError` vs `RangeError` vs `GuestThrownError`), structured discriminants (`.kind`, `.code`, etc.) intact.

Considered: minimal `{name, message, stack}`. Rejected — would lose F-2's structured-discriminant work for the guest-throw path, asymmetric with the host-throw path (which preserves discriminants via `sanitizeForGuest`).

### Decision 3 — Reject-or-envelope scope: guest throws → envelope; engine bugs → reject

Only the guest-originated rejection paths convert to envelope:

- `awaitGuestResult`'s `outcome.error` branch (guest VM rejected the promise) → `{ ok: false, error: GuestThrownError }`.
- `callGuestFn`'s `JSException` branch (guest VM threw synchronously inside the Callable invocation) → same envelope.

All other failure modes continue to reject:

- `CallableDisposedError` (plugin invoked Callable after dispose) — engine programming bug.
- `marshalArg` failure (host-side serialisation of an unmarshallable value) — engine programming bug.
- `currentVm` disposed mid-call — engine state bug; today this can happen during the post-`done` snapshot-restore window if a Callable invocation races the restore.

Rationale: the envelope is for the *expected* failure mode (guest throws are an inherent part of running untrusted code). Engine bugs should fail loud, mirroring F-2's principle that the curated path is the guest-originating path; engine bugs use the catch-all `BridgeError`.

This means timers' `fire()` could still kill the worker if it invokes a disposed Callable — but the existing `if (!entry) return;` guard handles the only path where this could realistically arise (clearAllPending removes entries before disposal). No new race surface.

### Decision 4 — Auto-unwrap location: pluginRequest's resolve handler

`pluginRequest` (`packages/sandbox/src/plugin.ts:301`) is the host-side request-frame wrapper that timers' `fire()` already routes through. Adding the auto-unwrap there means the timers consumer needs zero source change — pluginRequest sees the envelope, emits `system.error` close, resolves the outer promise with the envelope, and the discarded P1 resolves cleanly. The escape route is closed at the architectural choke point that already handles every host-fired Callable invocation under a request frame.

Considered: explicit `ctx.invokeCallable(callable, frame, ...args)` helper that plugins must adopt. Rejected — moves the burden to plugin authors and re-introduces the "future plugins must remember to use the helper" hazard. The pluginRequest auto-unwrap path inherits the fix transparently.

The discriminator is a non-enumerable Symbol property `Symbol.for("@workflow-engine/sandbox#callableResult")` attached via `Object.defineProperty` (defaults: non-enumerable, non-writable, non-configurable). Tagged-union shape sniff (`'ok' in value && ('value' in value || 'error' in value)`) was rejected as ambiguous — a plugin returning a literal `{ ok: true, value: 42 }` from a non-Callable code path would be mis-unwrapped. The Symbol brand is unforgeable from guest land (host-only).

Non-enumerable is required for `structuredClone` / `postMessage` safety: enumerable Symbol-keyed properties cause `DataCloneError`. The brand never crosses the worker boundary because pluginRequest unwraps before any event reaches the bus, but the non-enumerable default keeps the envelope clone-clean as defence-in-depth.

### Decision 5 — Outer promise resolves with envelope, never rethrows on envelope-error

When `pluginRequest`'s inner `fn()` resolves with `{ ok: false, error }`, pluginRequest emits `prefix.error` and resolves its outer promise with the envelope. It does **not** rethrow.

This is the load-bearing decision. Rethrowing would re-create the P1 escape route — pluginRequest's outer promise would reject, and the timers' `fire()` discarding it would resurrect F-3.

Awaiting plugins (those that hold a reference to the outer promise) get the envelope and can inspect it. Plugins that want reject-style ergonomics unwrap themselves: `if (!result.ok) throw result.error;` (this is exactly what `__sdk.dispatchAction` does post-migration; see `Decision 6`).

Considered: resolve with `undefined` on envelope-error. Rejected — asymmetric with success path, loses access to the structured error, forces awaiting plugins to subscribe to the event bus to recover information that was already in hand.

### Decision 6 — `__sdk.dispatchAction` migration to envelope inspection

`packages/sdk/src/sdk-support/index.ts:135` is the second in-tree Callable consumer (alongside timers). It awaits `handler(input)` directly inside the bridge's `buildHandler` closure, so the pluginRequest auto-unwrap does NOT cover it. Migration:

```ts
// before
const raw = await handler(input as GuestValue);
try {
    return validateActionOutput(actionName, raw);
} catch (err) { throw translateValidatorThrow(err); }

// after
const result = await handler(input as GuestValue);
if (!result.ok) {
    throw result.error;  // bridge-closure passes through unchanged via R-12
}
try {
    return validateActionOutput(actionName, result.value);
} catch (err) { throw translateValidatorThrow(err); }
```

The thrown `GuestThrownError` flows back through the surrounding `buildHandler`'s F-2 catch (`sanitizeForGuest`), which preserves `GuestThrownError` unchanged onto the calling guest VM as the action's throw. Action-level throw semantics for workflow authors are unchanged.

### Decision 7 — Audit shape asymmetry with `system.exception` leaf is intentional

Two distinct audit shapes for "guest-originated throw":

| Path | Shape | When |
|---|---|---|
| In-VM throw caught by reportError polyfill | `system.exception` leaf | guest `reportError(err)` call, EventTarget listener throw caught by polyfill — no host frame open at the moment of the throw |
| Guest throw inside a host-fired Callable (F-3 path) | `system.error` close (paired with `system.request` open) | timer callback, setInterval fire, future host-initiated frame whose body invokes a Callable |

The two shapes encode different facts: presence vs absence of a containing host-initiated frame. `system.error` close says "a host-initiated request frame ended because the guest threw inside it"; `system.exception` leaf says "a guest-side uncaught throw was reported without a containing host frame." Conflating them would erase frame structure (start, duration, parent) on the timer path or fabricate fake host activity on the in-VM path.

The path discriminator is structural: was a host frame open at the moment the throw became host-visible? Path II opens one (the request); Path I never had one. There is no overlap zone.

Border cases checked:

- `setTimeout(() => setTimeout(() => { throw }, 0), 0)` — outer frame closes cleanly with `system.response`, inner frame closes with `system.error`. Properly nested.
- `setInterval(() => { throw }, 100)` — one Path-II pair per fire. Audit shape per invocation.
- `addEventListener('x', () => { throw }); dispatchEvent('x')` — polyfill catches in-VM, calls reportError → `system.exception` leaf. F-3 path not engaged.
- `scheduler.postTask(() => { throw })` — polyfill wraps in try/catch + reportError → `system.exception` leaf, even though postTask uses setTimeout internally. F-3 path not engaged.

### Decision 8 — SECURITY.md §2 R-13 placement (twin of R-12)

The R-13 rule is framed as the symmetric pair of R-12 under the boundary-opacity umbrella, not as an extension of R-4 (cleanup ordering). Audit-forgery is the primary attacker gain: a hostile workflow author can force `kind:"crash"` worker terminations and `worker exited with code …` run rejections that pollute the operator's view of platform health. Cold-start CPU amplification (each forced worker death triggers a full re-init: WASM instantiate + plugin source eval + Phase-3 deletes + initial snapshot) is secondary, weak but real.

## Risks / Trade-offs

- **[Risk]** Existing tests that assert `await expect(callable()).rejects.toThrow(...)` for guest-throw paths break at compile time post-rebase. **Mitigation:** mechanical migration recipe documented in `tasks.md`; affected files explicitly listed (`callable-reentry.test.ts`, `bridge-install-descriptor.test.ts`, possibly more discovered during execution). Engine-bug tests that assert `.rejects` for `CallableDisposedError` / marshal failures keep working — those failure modes still reject.

- **[Risk]** Audit-trail asymmetry between envelope-path errors (full `GuestThrownError` shape) and non-envelope error paths (`serializeLifecycleError`-truncated) is preserved. Operators looking at `system.error` rows for fetch / mail / sql dispatcher failures still see less information than what reaches the guest VM. **Mitigation:** documented as known limitation in this design and `proposal.md`; tracked as follow-up that touches every host dispatcher (out of scope for F-3 because it changes wire shape on every existing `prefix.error` event in the codebase, which is a much bigger blast radius than F-3's local boundary fix).

- **[Risk]** `pluginRequest`'s resolve-handler branch grows a Symbol property check on every host-call request frame's resolution. **Mitigation:** brand check is O(1) Symbol lookup, ~5–15ns per resolve; envelope construction adds one young-gen allocation per Callable invocation; both are negligible relative to the cross-thread `postMessage` overhead that already dominates per-frame cost. Hidden-class stability preserved by always constructing the envelope with property order `{ ok, value | error }` and attaching the brand via `Object.defineProperty`.

- **[Risk]** Out-of-tree plugin consumers (none today, architecturally permitted) see a TS-breaking contract change. **Mitigation:** the breakage is type-checker-visible and the migration is mechanical (`if (!result.ok) throw result.error;`). Better than a silent runtime change. Documented in CLAUDE.md upgrade note.

- **[Risk]** `CallableDisposedError` continues to reject. If a future plugin invokes a disposed Callable from a deferred Node task and discards the promise, it could re-introduce a worker-death path. **Mitigation:** the only realistic disposal-after-defer shape is a TOCTOU race between `clearAllPending` and a fire callback; the existing `if (!entry) return;` guard in timers' `fire()` short-circuits before invocation. Codified in the new sandbox spec section as a constraint on Callable-consuming plugins. Engine bugs that hit this path are correctly fail-loud; that's intended.

- **[Risk]** A plugin author legitimately returning a literal `{ ok: true, value: 42 }` shape from a `pluginRequest`'d function would be mis-classified by a shape sniff. **Mitigation:** brand discrimination is via Symbol property, not shape. Symbol-keyed property access ignores literal `{ ok, value }` objects.

- **[Risk]** The non-enumerable brand attached via `Object.defineProperty` is unforgeable from guest land but could be forged by a plugin author writing a fake envelope. **Mitigation:** plugins are trusted code in the host; the brand is not a security boundary, it's a discriminator for host-side dispatch logic. R-13's threat model addresses guest-originated rejection escape, not malicious plugin authors.
