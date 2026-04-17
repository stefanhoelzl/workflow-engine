## 1. Core interface — add `at`, redefine `ts`

- [x] 1.1 Update `InvocationEvent` in `packages/core/src/index.ts`: add `readonly at: string`, change `ts` doc-comment to "integer µs since the current sandbox run's anchor."
- [x] 1.2 Run `pnpm check` and record all compiler errors that surface (these become the scope map for the rest of the change).

## 2. Sandbox — bridge-owned anchor

- [x] 2.1 In `packages/sandbox/src/bridge-factory.ts`, add private `anchorNs: bigint` state to `createBridge`, plus `resetAnchor()`, `anchorNs()`, and `tsUs()` methods on the returned bridge. `tsUs()` returns `Math.round((performance.now() - Number(anchorNs) / 1_000_000) * 1000)`.
- [x] 2.2 Update `buildEvent` to populate `at: new Date().toISOString()` and `ts: tsUs()`; remove the old `ts: Date.now()`.
- [x] 2.3 In `packages/sandbox/src/worker.ts`, replace both `ts: Date.now()` occurrences (`installEmitEvent`, `emitTriggerEvent`) with `at: new Date().toISOString()` and `ts: bridge.tsUs()`.
- [x] 2.4 In `packages/sandbox/src/worker.ts` `handleInit`, replace `wasiState.anchorNs = perfNowNs()` with `bridge.resetAnchor()`. In `handleRun`, same replacement.
- [x] 2.5 In `packages/sandbox/src/wasi.ts`, remove the `anchorNs` field from `WasiState`. Update `wasiClockTimeGet` to read `wState.bridge?.anchorNs() ?? 0n` for the MONOTONIC branch.
- [x] 2.6 Delete the now-unused `perfNowNs` export if no remaining consumers (grep first).

## 3. Runtime consumers — read `at`, write µs

- [x] 3.1 In `packages/runtime/src/event-bus/event-store.ts`, update the DDL: replace `ts TIMESTAMPTZ NOT NULL` with `at TIMESTAMPTZ NOT NULL` + `ts BIGINT NOT NULL`. Update `eventToRow` to pass `at: event.at` (no conversion) and `ts: event.ts`.
- [x] 3.2 Update any SELECTs inside `event-store.ts` that reference the old `ts` column to use `at` or `ts` correctly; re-export the Kysely typed row shape.
- [x] 3.3 In `packages/runtime/src/event-bus/logging-consumer.ts`, change `baseFields` to `ts: event.at` (direct pass-through of the ISO string — no `new Date(...)` wrapping).
- [x] 3.4 In `packages/runtime/src/recovery.ts`, change the synthetic event construction: add `at: new Date().toISOString()`, change `ts: Date.now()` to `ts: events.at(-1)?.ts ?? 0`.

## 4. Dashboard — order by `at`, smart-unit duration

- [x] 4.1 In `packages/runtime/src/ui/dashboard/middleware.ts`, switch the request-row projection to `startedAt: r.at`, duration inputs to `r.ts` / `t.ts`; add `ORDER BY at DESC, id DESC` to the query (via Kysely `.orderBy` chain).
- [x] 4.2 In `packages/runtime/src/ui/dashboard/page.ts`, replace `formatDuration(startMs, endMs)` with `formatDurationUs(us: number): string` implementing the smart-unit bands: `< 1_000 → "N µs"`, `< 1_000_000 → "N.N ms"`, `< 60_000_000 → "N.N s"`, else `"N.N min"`.
- [x] 4.3 Update `renderCard` to call `formatDurationUs(completedTs - startedTs)` when both are available; continue showing `—` when missing.

## 5. Tests — shared fixture helper + coverage

- [x] 5.1 Add a `makeEvent(overrides?: Partial<InvocationEvent>): InvocationEvent` helper in a shared test-utils location (e.g. `packages/core/src/test-utils.ts` or inline per package if cleaner). Defaults: `at: "2026-04-16T10:00:00.000Z"`, `ts: 0`, plus required fields (`kind: "trigger.request"`, `id: "evt_test"`, `seq: 0`, `ref: null`, `workflow: "w"`, `workflowSha: "sha"`, `name: "t"`).
- [x] 5.2 Migrate `packages/core/src/index.test.ts` fixtures to `makeEvent`.
- [x] 5.3 Migrate `packages/runtime/src/executor/index.test.ts` fixtures to `makeEvent`.
- [x] 5.4 Migrate `packages/runtime/src/integration.test.ts` fixtures to `makeEvent`.
- [x] 5.5 Migrate `packages/runtime/src/event-bus/event-store.test.ts` fixtures (previously used `ts: Date.parse("...")`) to supply `at: "<iso>"` and a plausible `ts: <µs>`.
- [x] 5.6 Migrate `packages/runtime/src/recovery.test.ts` fixtures, add a scenario asserting the synthetic terminal's `ts` equals the last replayed event's `ts`.
- [x] 5.7 Update the dashboard middleware test (`packages/runtime/src/ui/dashboard/middleware.test.ts`) to exercise the new query + row shape and the smart-unit duration formatter at the four band boundaries (999 µs → "999 µs", 1 000 → "1.0 ms", 1 000 000 → "1.0 s", 60 000 000 → "1.0 min").
- [x] 5.8 Add a sandbox test (`packages/sandbox/src/sandbox.test.ts`) asserting that a `trigger.request` event has `ts` within a small epsilon of 0 and that `terminal.ts > request.ts` for a non-trivial run.
- [x] 5.9 Add a sandbox test that `performance.now()` inside the guest and `bridge.tsUs()` on the host side share an anchor (read both back-to-back, assert their difference is within one sample).
- [x] 5.10 Add a sandbox security test: verify `at` / `ts` on InvocationEvents emitted via `ctx.emit` cannot be controlled by guest code (guest cannot pass `at`/`ts` through `__emitEvent`; host overrides them).

## 6. Operational — wipe existing state

- [x] 6.1 Add a note to `CLAUDE.md` under the project-notes section: "Upgrading past the monotonic-timestamps change requires wiping `pending/` and `archive/` prefixes under the storage backend; in-memory DuckDB resets on its own."
- [x] 6.2 Verify locally: stop the runtime, `rm -rf` local storage-backend data dir, restart with `pnpm start`; dashboard renders empty; execute a webhook; dashboard shows a row with a sub-ms duration reported from the new smart-unit formatter.

## 7. Validate

- [x] 7.1 `pnpm lint` passes.
- [x] 7.2 `pnpm check` passes.
- [x] 7.3 `pnpm test` passes (unit + integration, excluding WPT which is unaffected).
- [x] 7.4 `pnpm validate` passes.
- [x] 7.5 `pnpm exec openspec validate monotonic-event-timestamps --strict` passes.
