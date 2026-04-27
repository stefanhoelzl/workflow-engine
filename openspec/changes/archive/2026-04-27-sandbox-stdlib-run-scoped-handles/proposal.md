## Why

The mail plugin (`packages/sandbox-stdlib/src/mail/worker.ts`) allocates a fresh `nodemailer` `Transport` per `sendMail` call but only closes it in the per-call `finally`. If the guest fires `sendMail` without awaiting it, the dispatcher's `await transport.sendMail(...)` continues executing on the persistent Node worker thread past the QuickJS snapshot-restore boundary — the SMTP socket lives across runs even though the QuickJS-side state is restored cleanly. This is an R-4 (per-run cleanup) violation already addressed by the `timers` and `sql` plugins via `onRunFinished` backstops; mail's gap is the only stdlib plugin instance of the same class of leak. While auditing the gap, we found that `fetch` exhibits a related (weaker) symptom — in-flight requests escaping the run consume worker time during the *next* run's window, even though undici's process-wide pool prevents the socket-leak vector. Both gaps are best closed by a single shared helper, codifying the rule for future plugin authors.

## What Changes

- Add `createRunScopedHandles<T>(close)` helper to `packages/sandbox-stdlib/src/internal/run-scoped-handles.ts` exposing `track(h)`, `release(h)`, `drain()`. Internal to sandbox-stdlib (not exported from the package index).
- Mail plugin: track per-call `Transport` via the helper; `worker()` returns `onRunFinished: handles.drain`. Per-call close errors swallowed (nodemailer's `SMTPTransport.close()` is sync and idempotent under double-call).
- Fetch plugin: track per-call `AbortController` via the helper; `onRunFinished` aborts in-flight requests. Worker-time fairness; audit safety is independently guaranteed by the existing worker-side `bridge.clearRunActive()` gate (`packages/sandbox/src/worker.ts:675`).
- SQL plugin: refactor existing `openHandles: Set` + manual drain to use the shared helper. Behaviour-preserving — same `Promise.allSettled` semantics, same `.end({timeout:0})` closer.
- Refine SECURITY.md R-4 with the "per-call vs pool-shared" rule (per-call resources need a backstop; pool-shared resources are governed by the pool, not the run) and the "audit safety comes from the worker gate, not the backstop" note.
- Add new SECURITY.md subsection **"Adding a system-bridge plugin"** with a numbered checklist (net-guard ordering, run-scoped handles, reserved prefix, structured errors, redacted logging, timeouts, JSON-serializable config) enforced by review.

**Out of scope (explicitly deferred)**: a `createSystemBridgePlugin(spec)` higher-order factory that would unify mail/sql/fetch under a strategy interface. The factory's shape is not yet validated — `fetch` is a structural misfit (net-guard happens per redirect hop inside the undici connector, not in a single `acquire` step), and `mail` + `sql` alone are too similar (Rule of Three not satisfied) to extract a generalisable abstraction. The factory will be proposed as a follow-up once a fourth per-call-resource plugin (IMAP host-side, S3, gRPC, LDAP, etc.) provides a third clean fit. Until then, the policy enforcing the same outcome lives as a SECURITY.md checklist.

No author-visible behaviour change. No manifest format change. No event-shape change. No new event kinds.

## Capabilities

### New Capabilities

(none — this change adds an internal helper and adjusts existing plugin lifecycles, no new spec capability)

### Modified Capabilities

- `sandbox-stdlib`: mail plugin gains an `onRunFinished` backstop requirement; fetch plugin gains an `onRunFinished` backstop requirement; sql plugin's existing backstop is restated in terms of the shared helper. The timers plugin's existing backstop is unchanged in behaviour but its requirement text is generalised to reference the shared helper pattern.

## Impact

**Code**
- `packages/sandbox-stdlib/src/internal/run-scoped-handles.ts` (new)
- `packages/sandbox-stdlib/src/internal/run-scoped-handles.test.ts` (new)
- `packages/sandbox-stdlib/src/mail/worker.ts` (modified — backstop wiring)
- `packages/sandbox-stdlib/src/mail/mail.test.ts` (modified — backstop coverage)
- `packages/sandbox-stdlib/src/fetch/index.ts` (modified — backstop wiring)
- `packages/sandbox-stdlib/src/fetch/hardened-fetch.ts` (modified — expose AbortController to descriptor handler so the helper can track it)
- `packages/sandbox-stdlib/src/fetch/fetch.test.ts` (modified — backstop coverage)
- `packages/sandbox-stdlib/src/sql/worker.ts` (modified — refactor to shared helper)
- `packages/sandbox-stdlib/src/sql/sql.test.ts` (modified — verify parity post-refactor)

**Specs**
- `openspec/specs/sandbox-stdlib/spec.md` — modified-capability delta (mail + fetch + sql + timers requirement adjustments)

**Security documentation**
- `SECURITY.md` R-4 refinement (per-call vs pool-shared rule; worker-gate audit-safety note)
- `SECURITY.md` new subsection "Adding a system-bridge plugin" (review-enforced checklist)

**Dependencies, APIs, wire shapes, manifest**
- No changes. No tenant rebuild required. No event surface change.

**Operator-visible**
- No new log lines. No new metrics. No CrashLoopBackOff change.

**Author-visible**
- None. SDK exports unchanged. `demo.ts` unchanged.
