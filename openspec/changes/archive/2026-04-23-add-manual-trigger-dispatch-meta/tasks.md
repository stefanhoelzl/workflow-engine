## 1. Core event-type + fire contract

- [x] 1.1 Add `DispatchMeta` type to `packages/core/src/index.ts`: `{ source: "trigger" | "manual"; user?: { name: string; mail: string } }`; export it alongside `InvocationEvent`.
- [x] 1.2 Widen `InvocationEvent` in `packages/core/src/index.ts` with an optional `meta?: { dispatch?: DispatchMeta }` field; `SandboxEvent` stays unchanged.
- [x] 1.3 Widen the `fire` closure type on `TriggerEntry<D>` in `packages/runtime/src/workflow-registry.ts` (and the ambient declaration imported by `TriggerSource` backends) to `(input: unknown, dispatch?: DispatchMeta) => Promise<InvokeResult<unknown>>`.
- [x] 1.4 Update `packages/runtime/src/triggers/build-fire.ts` to accept `dispatch?: DispatchMeta` and forward it to the executor; on validation failure continue to resolve without dispatching.

## 2. Executor stamping

- [x] 2.1 Refactor `Executor.invoke` signature in `packages/runtime/src/executor/index.ts` + `executor/types.ts` from `(tenant, workflow, descriptor, input, bundleSource)` to `(tenant, workflow, descriptor, input, { bundleSource, dispatch? })`; update the `Executor` interface export.
- [x] 2.2 Extend the per-sandbox `activeMeta` record in `executor/index.ts` to include `dispatch: DispatchMeta`; populate it from `options.dispatch ?? { source: "trigger" }` at `runInvocation` entry.
- [x] 2.3 Update the `sb.onEvent` widener in `executor/index.ts` to attach `meta: { dispatch: meta.dispatch }` to the widened event **only when** `event.kind === "trigger.request"`; all other kinds MUST NOT receive a `meta` field.
- [x] 2.4 Update every caller of `executor.invoke` across the monorepo (buildFire, tests, any other internal callers) to the new options-bag signature.

## 3. UI trigger middleware + page

- [x] 3.1 In `packages/runtime/src/ui/trigger/middleware.ts`, make the `POST /trigger/:tenant/:workflow/:trigger` handler kind-aware: when `descriptor.kind === "http"`, wrap the posted JSON as `{ body: posted, headers: {}, url: "/webhooks/<tenant>/<workflow>/<trigger>", method: descriptor.method }` before calling `fire`; otherwise pass the posted JSON as input.
- [x] 3.2 In the same handler, build `dispatch`: always `{ source: "manual" }`; when `c.get("user")` is defined, add `user: { name: user.name, mail: user.mail }`. Pass it as the second argument to `entry.fire`.
- [x] 3.3 In `packages/runtime/src/ui/trigger/page.ts` (HTTP branch of `descriptorToCardData`), flip `submitUrl` from `/webhooks/<tenant>/<workflow>/<name>` to `/trigger/<tenant>/<workflow>/<name>`. Leave the `meta` chip text unchanged — it still documents the public webhook URL.
- [x] 3.4 Verify `packages/runtime/src/ui/static/trigger-forms.js` requires no change (the kind-agnostic POST via `data-trigger-url` + three-state result dialog already covers this).

## 4. EventStore persistence

- [x] 4.1 Add `meta JSON` (nullable) column to the `CREATE TABLE IF NOT EXISTS events` DDL in `packages/runtime/src/event-bus/event-store.ts`.
- [x] 4.2 Update `eventToRow()` to serialize `event.meta` to a JSON string when present, otherwise `NULL`; symmetric deserialization path in any loader/reader that materializes `InvocationEvent` from a row.
- [x] 4.3 Confirm archive JSON serialization in `packages/runtime/src/persistence/*` tolerates a present-or-absent `meta` top-level field on events: writers emit it when present; readers tolerate its absence.
- [x] 4.4 Lock in a regression test: loading an archive file that has no `meta` field on its events produces rows with `meta = NULL` and no exception.

## 5. Dashboard invocation list

- [x] 5.1 Extend `fetchInvocationRows` in `packages/runtime/src/ui/dashboard/middleware.ts` to select the `meta` column from the `trigger.request` query; parse `meta.dispatch` into dispatch fields on the `InvocationRow`.
- [x] 5.2 Extend `InvocationRow` interface (`packages/runtime/src/ui/dashboard/middleware.ts` or a sibling types module) with optional `dispatch?: { source: "manual" | "trigger"; user?: { name: string } }` (mail is not rendered on the list to keep the row compact; it's still visible in the flamegraph tooltip's JSON).
- [x] 5.3 Update the row renderer in `packages/runtime/src/ui/dashboard/page.ts` (or wherever `renderCard` lives) to render a `manual by <name>` chip when `dispatch.source === "manual"` and `dispatch.user.name` is present; render `manual` when `source === "manual"` with no user; render nothing when `source === "trigger"` or `dispatch` is absent.
- [x] 5.4 Style the chip in `packages/runtime/src/ui/static/workflow-engine.css` using existing tokens (match the "failed"/"succeeded" chip visual weight but use a neutral-info color).

## 6. Trigger-source backends: no-op forwarding

- [x] 6.1 Verify `packages/runtime/src/triggers/http.ts` and `packages/runtime/src/triggers/cron.ts` continue to call `entry.fire(input)` with no dispatch argument (they should; this task is a read-only check + a comment at each call site noting that omitting dispatch intentionally selects `source: "trigger"`).

## 7. Tests

- [x] 7.1 Unit test in `packages/runtime/src/executor/executor.test.ts` (or equivalent): invoke with `dispatch = { source: "manual", user }` → only the `trigger.request` event carries `meta.dispatch`; `action.*`, `trigger.response`, `trigger.error` do not.
- [x] 7.2 Unit test in the same file: invoke without any dispatch argument (options-bag passes only `bundleSource`) → `trigger.request` carries `meta.dispatch = { source: "trigger" }` with no `user`.
- [x] 7.3 Unit test in `packages/runtime/src/triggers/build-fire.test.ts`: fire closure forwards dispatch unchanged; on validation failure no executor call and no dispatch stamping.
- [x] 7.4 Unit test in `packages/runtime/src/ui/trigger/middleware.test.ts`: authenticated cron fire → `fire` called with `dispatch = { source: "manual", user: {name, mail} }`; unauthenticated fire → `dispatch = { source: "manual" }` with no user; cross-tenant fire → 404 without dispatch call.
- [x] 7.5 Unit test in the same file: HTTP descriptor fire → handler synthesizes `{ body, headers: {}, url: "/webhooks/<t>/<w>/<n>", method }` and calls fire with that input and dispatch.
- [x] 7.6 Unit test in `packages/runtime/src/event-bus/event-store.test.ts`: a `trigger.request` event with `meta: { dispatch }` persists into the `meta` column (JSON-serialized); a non-trigger event persists with `meta = NULL`.
- [x] 7.7 Unit test in the same file: archive bootstrap with legacy events lacking `meta` loads into `meta = NULL` rows without throwing.
- [x] 7.8 Unit test in `packages/runtime/src/ui/dashboard/page.test.ts` (or wherever rendering is tested): row with `dispatch.source = "manual"` + user renders `"manual by Jane Doe"` chip; row with `source = "trigger"` renders no chip; legacy row with no dispatch renders no chip.
- [x] 7.9 Integration test: end-to-end POST `/trigger/<tenant>/<workflow>/<name>` with authenticated session for HTTP trigger → archive file under `archive/<id>.json` contains `meta.dispatch` with `source: "manual"` and the session's user.
- [x] 7.10 Integration test: end-to-end POST `/webhooks/<tenant>/<workflow>/<name>` (no session) for the same trigger → archive contains `meta.dispatch = { source: "trigger" }` and no user.
- [x] 7.11 Confirm `pnpm validate` passes (lint + type + tests) locally before opening the PR.

## 8. Security invariants documentation

- [x] 8.1 Add a new §2 R-rule to `SECURITY.md` (next free R-number): "`InvocationEvent.meta` and every field nested under it (including `meta.dispatch`) are stamped only at the executor's `sb.onEvent` widener. Sandbox code and plugin code MUST NOT emit or read `meta`." Parallels R-8.
- [x] 8.2 Update `SECURITY.md` §4 to record that UI-initiated HTTP trigger fires go through `/trigger/*` (authenticated via oauth2-proxy forward-auth + `requireTenantMember`); the `/webhooks/*` ingress remains unauthenticated for external callers per §3. Reinforce that adding auth to `/webhooks/*` is still forbidden.
- [x] 8.3 Add the matching NEVER bullet to `CLAUDE.md`'s Security Invariants section pointing to the new §2 R-rule.

## 9. Upgrade notes

- [x] 9.1 Add an entry to `CLAUDE.md` under `## Upgrade notes` named `add-manual-trigger-dispatch-meta` describing: new `meta.dispatch` on `trigger.request` events; new `meta JSON` column on the events table; UI HTTP trigger fires now go through `/trigger/*`; no state wipe; no tenant re-upload; SDK surface unchanged; behavior note that UI-fired HTTP triggers now carry empty `headers` and a relative `url` in their payload.
