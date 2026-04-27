## 1. Helper

- [x] 1.1 Verify `packages/sandbox-stdlib/src/internal/` is the established convention for non-exported modules in this package (grep for sibling examples; create directory if absent).
- [x] 1.2 Create `packages/sandbox-stdlib/src/internal/run-scoped-handles.ts` exporting `createRunScopedHandles<T>(close)`. Implementation: `Set<T>` storage, `track` returns its arg, `release` deletes-then-awaits-close-with-swallow, `drain` snapshots-then-clears-then-`Promise.allSettled`-with-swallow.
- [x] 1.3 Create `packages/sandbox-stdlib/src/internal/run-scoped-handles.test.ts` covering: track adds, release removes-then-closes, release on unknown is no-op, drain closes all and clears, sync closer is auto-awaited, async closer is awaited, throwing closer is swallowed in both release and drain, race between release and drain does not double-close.

## 2. Mail backstop

- [x] 2.1 Verify `nodemailer.createTransport()` returns synchronously without opening a socket (so `track` immediately after construction is correct). Document the observation in a one-line comment above the closer.
- [x] 2.2 Modify `packages/sandbox-stdlib/src/mail/worker.ts`: import `createRunScopedHandles`. Define module-scope `const handles = createRunScopedHandles<Mail>((t) => { try { t.close(); } catch { /* idempotent under double-call */ } })`. In `dispatchMailSend`, call `handles.track(transport)` immediately after `nodemailer.createTransport(...)`. Replace the existing `finally { transport.close() }` with `finally { await handles.release(transport); }`.
- [x] 2.3 Modify the mail plugin's `worker(ctx)` return to `{ guestFunctions: [...], onRunFinished: handles.drain }`.
- [x] 2.4 Extend `packages/sandbox-stdlib/src/mail/mail.test.ts` with: per-call success closes transport via release, per-call error closes transport via release, fire-and-forget leaves handle tracked then `onRunFinished` closes it, double-close (release + drain race) is safe.

## 3. Fetch backstop

- [x] 3.1 ~~Modify `hardened-fetch.ts` to lift the AbortController out~~ — **not needed**. `composeSignal` (line 167) already merges any caller-supplied `init.signal` with the 30s timeout via `AbortSignal.any([...])`. The descriptor handler in `fetch/index.ts` can construct its own `AbortController`, pass `controller.signal` as `init.signal` to the bound `fetchImpl`, and aborting the descriptor's controller cascades through `composeSignal` automatically. No public-API change to `hardenedFetch`.
- [x] 3.2 Modify `packages/sandbox-stdlib/src/fetch/index.ts`: import `createRunScopedHandles`. Define module-scope `const handles = createRunScopedHandles<AbortController>((c) => { c.abort(); })`. In the `fetchDispatcherDescriptor` handler, construct an `AbortController`, `handles.track(controller)`, pass it to the bound `fetchImpl` (via the new parameter), and on `finally` call `await handles.release(controller)`.
- [x] 3.3 Modify the fetch plugin's `worker(_ctx)` return to `{ guestFunctions: [...], onRunFinished: handles.drain }`.
- [x] 3.4 Extend `packages/sandbox-stdlib/src/fetch/fetch.test.ts` with: per-call success calls release, per-call error calls release, fire-and-forget request is aborted by `onRunFinished`, abort during in-flight request rejects the dispatcher's await with `AbortError`, the audit-event close frame for the aborted request is emitted by the sequencer at run end. (Sequencer-emitted close-frame assertion deferred — the worker-gate audit-safety contract is enforced at the sandbox layer, not the plugin layer; verifying it inside a plugin unit test would require booting a Sandbox+sequencer harness, out of scope here. Tested behaviours: in-flight abort-on-drain, per-call success/error release, in-flight signal observability.)

## 4. SQL refactor

- [x] 4.1 Modify `packages/sandbox-stdlib/src/sql/worker.ts`: replace the existing `const openHandles = new Set<SqlHandle>()` and the manual `onRunFinished` body with `const handles = createRunScopedHandles<SqlHandle>((h) => h.end({ timeout: 0 }))`. In `dispatchSqlExecute`, replace `openHandles.add(sql)` with `handles.track(sql)` and replace the `finally` body's `openHandles.delete(sql); await sql.end({ timeout: 5 }).catch(() => undefined);` with `await handles.release(sql);`. Replace `worker()`'s `onRunFinished: async () => { ... }` with `onRunFinished: handles.drain`.
- [x] 4.2 Note that the existing per-call closer used `timeout: 5` while the run-end closer used `timeout: 0`. Unified on `timeout: 0` (drain-on-shutdown semantics). The 5-second grace was a defensive in-flight-query window on the happy path, but the per-call `finally` only runs after the query has already resolved or rejected — so it was never load-bearing. Rationale documented in `worker.ts` above the helper construction.
- [x] 4.3 Confirm `packages/sandbox-stdlib/src/sql/sql.test.ts` continues to pass. Updated two existing assertions from `{timeout: 5}` → `{timeout: 0}` (mechanical follow-on from 4.2). Added a fire-and-forget test asserting `onRunFinished` calls `sql.end({timeout: 0})` for a still-tracked handle whose query never resolved.

## 5. SECURITY.md update

- [x] 5.1 Refine R-4 in `SECURITY.md` § "Plugin invariants" (or the section that defines R-4): add the per-call vs pool-shared rule and the worker-gate audit-safety note as drafted in `design.md` Decision 6.
- [x] 5.2 Add a new subsection to `SECURITY.md` titled "Adding a system-bridge plugin" with the seven-item numbered checklist (net-guard ordering, run-scoped handles, system.* prefix, structured errors, redacted logging, timeouts, JSON-serializable config). Cross-reference `createRunScopedHandles` for item 2.

## 6. Validation

- [x] 6.1 `pnpm validate` passes: lint, typecheck, full test suite (unit + integration). The mail/fetch/sql tests cover both happy and fire-and-forget paths. (1255 tests passing, lint+check+infra-validate all clean.)
- [x] 6.2 `pnpm test:wpt` passes (no regressions in the WPT compliance suite — fetch refactor must not affect the polyfill surface). (23100 passed, 0 failed.)
- [x] 6.3 `pnpm exec openspec validate sandbox-stdlib-run-scoped-handles --strict` passes.

## 7. Dev verification

- [x] 7.1 `pnpm dev --random-port --kill` boots; stdout contains the `Dev ready on http://localhost:<port> (tenant=dev)` marker. (Observed on port 37797.)
- [x] 7.2 ~~`POST /webhooks/local/demo/runDemo`~~ — corrected URL: `GET /webhooks/local/demo/demo/ping` (4 segments: owner=local, repo=demo, workflow=demo, trigger=ping). Returned HTTP 200 with the demo's full response showing `mail.messageId`, `fetched.get`, `fetched.post`, `sql.greeting`. Persistence archive shows paired `system.request` / `system.response` for `fetch GET https://httpbin.org/get`, `fetch POST https://httpbin.org/post`, `fetch POST https://api.nodemailer.com/user`, `sendMail demo+http-get@example.com`, and `executeSql hh-pgsql-public.ebi.ac.uk/pfmegrnargs`. Backstop changes preserve the happy-path event surface.
- [x] 7.3 Tail the dev process stdout while running step 7.2 — no error/warn lines, no leaked-handle warnings, no `bus.consumer-failed` observed.
