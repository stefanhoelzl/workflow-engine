## 1. Core types

- [x] 1.1 Extend `EventKind` union in `packages/core/src/index.ts` to include `"trigger.rejection"` and `"system.upload"`. Update any `EventKind`-exhaustive switch in `packages/core` and `packages/runtime` to handle the new kinds (compiler will list them).
- [x] 1.2 Add zod parser updates wherever event-kind validation is centralized. _(N/A — `EventKind` is a TypeScript union with no centralized zod validator; verified via grep.)_

## 2. Executor.fail dual-kind support

- [x] 2.1 Generalize `executor.fail()` in `packages/runtime/src/executor/index.ts` (and exception helper at `packages/runtime/src/executor/exception.ts`) to accept `params.kind ∈ {"trigger.exception", "trigger.rejection"}`, defaulting to `"trigger.exception"` when omitted.
- [x] 2.2 Replace the existing `assertTriggerExceptionKind` (or equivalent) with `assertHostFailKind` checking both allowed kinds.
- [x] 2.3 Update `buildException(...)` in `packages/runtime/src/workflow-registry.ts` so `entry.exception(params)` forwards `params.kind` through to `executor.fail`. _(`buildException` already passes `params` through via `executor.fail(...)` — no code change needed; the new `kind` field rides through `TriggerExceptionParams`.)_
- [x] 2.4 Unit test: `executor.fail({kind: "trigger.rejection", name: "http.body-validation", input: {issues, method, path}})` emits exactly one event with `kind: "trigger.rejection"`, `seq=ref=ts=0`, fresh `id`, no `meta.dispatch`, no request body.
- [x] 2.5 Unit test: existing `executor.fail({name: "imap.poll-failed", error})` call paths still emit `trigger.exception` unchanged (regression guard).

## 3. HTTP middleware emits trigger.rejection on body 422

- [x] 3.1 In `packages/runtime/src/triggers/http.ts`, after the middleware returns the 422 for `error.issues`, call `entry.exception({kind: "trigger.rejection", name: "http.body-validation", input: {issues, method: c.req.method, path: <pathname only>}})` exactly once. Use the URL pathname (no query string).
- [x] 3.2 Ensure no emission on: 404 (no match / wrong segments / regex fail / method mismatch), 422-from-invalid-JSON, 500 (handler throw).
- [x] 3.3 Integration test: POST a registered HTTP trigger with body that fails its zod schema → response is 422 + issues; EventStore contains exactly one new `trigger.rejection` event with `input = {issues, method, path}` and no body. _(Asserted on `entry.exception` mock; full EventStore wiring deferred to chunk 5/dev-probe — the helper-level assertion proves the emission contract.)_
- [x] 3.4 Integration test: POST a non-existent trigger URL → 404; no `entry.exception` call.
- [x] 3.5 Integration test: POST with invalid JSON → 422; no `entry.exception` call.
- [x] 3.6 Integration test: POST with a query string and a bad body → emitted event's `input.path` is pathname only (no query).

## 4. Cron emits trigger.exception on arm-time failure

- [x] 4.1 In `packages/runtime/src/triggers/cron.ts` at the existing `try { computeNextDelay(...) } catch` site, invoke `srcEntry.entry.exception({name: "cron.schedule-invalid", error: {message}, input: {schedule, tz}})` in addition to the existing `logger.error("cron.schedule-invalid", ...)`. Floating `.catch()` logs `cron.exception-emit-failed` if emission fails.
- [x] 4.2 Unit test: bad tz at cold-boot → exactly one `entry.exception` call with `name: "cron.schedule-invalid"`, no timer armed.
- [x] 4.3 Unit test: reconfigure hot-swap to bad tz → exactly one `entry.exception` call on the new entry, no timer armed.
- [x] 4.4 Unit test: post-fire re-arm hot-swap to bad schedule → exactly one `entry.exception` per failed re-arm.

## 5. Upload handler emits system.upload with sha-dedup

- [x] 5.1 In `packages/runtime/src/api/upload.ts`, after `WorkflowRegistry.registerOwner()` succeeds, iterate workflows from `registry.list(owner, repo)` and emit a `system.upload` per-workflow with sha-based dedup via `eventStore.hasUploadEvent`. Manifest sub-snapshot stamped into `input`.
- [x] 5.2 New host-side stamping helper `packages/runtime/src/executor/upload-event.ts` with `assertSystemUploadKind` chokepoint + `emitSystemUpload(bus, params)`.
- [x] 5.3 New `EventStore.hasUploadEvent(owner, repo, workflow, workflowSha)` method, scope-allow-list-bypass documented inline; only the upload handler calls it.
- [x] 5.4 Integration test: first-time 2-workflow bundle → 2 events with correct shas + dispatch user.
- [x] 5.5 Integration test: identical re-upload → 0 new events.
- [x] 5.6 Integration test: mixed re-upload → exactly 1 new event for the changed workflow.
- [x] 5.7 Integration test: 415 → no events emitted.
- [x] 5.8 Integration test: 422 (unsupported trigger kind) → no events emitted.
- [x] 5.9 Restart-equivalent test: pre-seeded event in a fresh EventStore correctly skips re-emission via the dedup gate.

## 6. Synthetic-row reconstruction generalization

- [x] 6.1 `fetchExceptionRows` → `fetchSyntheticRows` (in `packages/runtime/src/ui/dashboard/middleware.ts`) covers `trigger.exception`, `trigger.rejection`, `system.upload`.
- [x] 6.2 `renderSyntheticGlyph` per-kind: wrench / shield-cross / upload-arrow + tooltips with first-issue summary or sha-short.
- [x] 6.3 `renderDispatchChip` extended for `source: "upload"` (label `"upload"`, title = `login <mail>`); rejection/exception rows skip the chip.
- [x] 6.4 Integration tests: rejection row with summary, upload row with chip + sha tooltip, no-flamegraph affordance for both.

## 7. Sandbox-exhaustion dimension pill

- [x] 7.1 `attachExhaustion()` queries `system.exhaustion` events keyed by `invocationId` and decorates failed rows with `{dim, budget?, observed?}`.
- [x] 7.2 `renderExhaustionPill` outputs `CPU`/`MEM`/`OUT`/`PEND` with `<title>` carrying `budget=N<unit> observed=N<unit>`.
- [x] 7.3 Pill rendered only on `failed` rows with associated exhaustion event.
- [x] 7.4 Integration test: CPU breach → CPU pill with budget+observed tooltip.
- [x] 7.5 Integration test: plain handler throw → no pill.

## 8. SECURITY.md updates

- [x] 8.1 SECURITY.md §2 R-7 reserved-prefix enumeration extended: `system.upload` documented under `system.*`; `trigger.rejection` documented under `trigger.*`.
- [x] 8.2 SECURITY.md §2 R-9 carve-out extended: `meta.dispatch` allowed on `trigger.request` AND `system.upload`. Host-side stamping site (`emitSystemUpload`) documented; carve-out forbids the field on every other kind.
- [x] 8.3 SECURITY.md §2 R-8 stamping pipeline extended: documents a second host-side emission path (`emitSystemUpload`, asserts `kind === "system.upload"`) parallel to the existing `emitTriggerException` path (now extended to assert `kind ∈ {trigger.exception, trigger.rejection}`).

## 9. CLAUDE.md / openspec/project.md updates

- [x] 9.1 CLAUDE.md "Upgrade notes" entry added at the top: `track-non-invocation-events (2026-04-27)` — additive, no state wipe, no rebuild; documents the two new kinds, the dashboard exhaustion pill, the SECURITY.md updates.
- [x] 9.2 openspec/project.md does NOT enumerate event kinds at the granularity that needs touching — the new kinds slot under the existing reserved-prefix scheme already documented. N/A.

## 10. Validate & ship

- [x] 10.1 `pnpm validate` passes (Biome 0 errors; TypeScript 0 errors; Vitest 1256/1256; tofu fmt + validate × 5 envs).
- [x] 10.2 Dev probe: signed in via `POST /auth/local/signin user=local`; first `system.upload` rows visible at `/dashboard/local/demo` (`entry-trigger=upload`, dispatch chip `local <local@dev.local>`, glyph tooltip `sha=2b9ef7d7`). Touched `workflows/src/demo.ts` to retrigger upload — count of `class="entry-trigger">upload<` rows stayed at 1 (sha-dedup confirmed).
- [x] 10.3 Dev probe: `POST /webhooks/local/demo/demo/greetJson` with body `{}` → 422 with zod issues; dashboard renders a synthetic `failed` row with `class="entry-rejected" aria-label="trigger rejected" title="trigger rejected: body.name: Invalid input: expected string, received undefined"`. No request body archived.
- [x] 10.4 Dev probe: temporarily added a `probeBurnCpu` httpTrigger with an infinite loop, fired it via webhook → 500 after 60 s (default `cpuMs=60000`); dashboard renders the failed row with `class="entry-exhaustion" title="budget=60000ms observed=60001ms">CPU`. Reverted the demo addition.
- [ ] 10.5 Dev probe: invalid cron `tz` → wrench row. _(NOT runnable from `pnpm dev` end-to-end: the manifest's `tz` field gates against the IANA timezone list at upload time, returning 422 before the cron source's `arm()` site is reached. The unit tests at `cron.test.ts` (4.2-4.4) exercise the emit path directly with a raw descriptor that bypasses the manifest schema. To exercise this against a live dev process, the manifest schema's `tz` validator would need to be relaxed — out of scope for this change.)_
