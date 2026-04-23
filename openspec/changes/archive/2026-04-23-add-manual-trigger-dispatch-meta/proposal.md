## Why

Today, a manual fire from the `/trigger/*` UI and an external wake (HTTP webhook POST or cron tick) produce indistinguishable `trigger.request` events: same `name`, same `input`, no attribution. Operators cannot tell from the dashboard or the archive whether a workflow ran because a scheduled tick fired, an external caller hit the webhook, or a signed-in user clicked Submit — and if it was a user, which one. This change introduces dispatch provenance on the invocation event so manual fires are attributable and filterable, and reroutes HTTP triggers fired from the UI through the authenticated `/trigger/*` endpoint so user identity can actually be captured (the public `/webhooks/*` ingress is unauthenticated by design and cannot attribute).

## What Changes

- Widen `InvocationEvent` with an optional `meta?` field. For `trigger.request` events, `meta.dispatch` carries `{source: "trigger" | "manual"; user?: {name, mail}}`. `source` is always populated on `trigger.request`; `user` is populated only when a manual fire has an authenticated session.
- Add a new nullable `meta JSON` column to the DuckDB events table. Kind-agnostic column name; content is kind-specific (same pattern as `input`/`output`/`error`). Available for future kind-specific runtime meta.
- Widen the `fire` closure signature on every `TriggerEntry` from `(input) => Promise<InvokeResult>` to `(input, dispatch?) => Promise<InvokeResult>`. Default dispatch when omitted: `{source: "trigger"}`.
- Refactor `Executor.invoke` to take an options bag: `invoke(tenant, workflow, descriptor, input, {bundleSource, dispatch?})`. Dispatch is stored in the per-sandbox `activeMeta` alongside `id/tenant/workflow/workflowSha` and stamped onto the widened event only when `event.kind === "trigger.request"`.
- Reroute HTTP triggers fired from the trigger UI through `/trigger/<tenant>/<workflow>/<name>` instead of the public `/webhooks/<tenant>/<workflow>/<name>` ingress. The `/trigger/*` handler becomes kind-aware: for HTTP descriptors it wraps the posted JSON into `{body, headers: {}, url: "/webhooks/<t>/<w>/<n>", method: descriptor.method}` before calling `fire`. External callers continue to use `/webhooks/*` unchanged.
- Capture the authenticated user (`name`, `mail`) from the session in the `/trigger/*` handler and pass it as `dispatch.user`. When no session is present (open-mode dev), `source: "manual"` is still emitted with `user` omitted.
- Surface dispatch on the dashboard invocation list: add a `manual by <name>` text chip on rows whose invocation's `trigger.request` carries `source: "manual"`. No chip for `source: "trigger"`. The flamegraph's `trigger.request` tooltip already renders event JSON, so `meta.dispatch` surfaces there for free.
- **BREAKING** internal runtime contract: `TriggerSource` backends calling `entry.fire(input)` continue to work (dispatch defaults to `{source: "trigger"}`), but the `Executor.invoke` signature changes shape. Trigger-source backends do not need to change; only internal callers of `Executor.invoke` are affected.
- New **SECURITY.md §2 R-rule**: `meta` (including `meta.dispatch`) is stamped only at the executor's `sb.onEvent` widener; sandbox and plugin code MUST NOT emit or read it (parallels R-8 for `id/tenant/workflow/workflowSha`).
- **SECURITY.md §4** note: UI-initiated HTTP trigger fires go through `/trigger/*` (authenticated forward-auth + `requireTenantMember`); `/webhooks/*` remains unauthenticated for external callers per §3. Adding authentication to `/webhooks/*` is still forbidden.

## Capabilities

### New Capabilities

None. All changes extend existing capabilities.

### Modified Capabilities

- `invocations`: `InvocationEvent` gains an optional `meta` field; `trigger.request` events SHALL carry `meta.dispatch` with `source` always populated.
- `executor`: `Executor.invoke` signature refactors to an options bag; executor stamps `meta.dispatch` onto the widened `trigger.request` event only.
- `triggers`: `TriggerEntry.fire` signature widens to accept an optional `dispatch` parameter; default on omission is `{source: "trigger"}`.
- `trigger-ui`: HTTP triggers fired from the UI route through `/trigger/<tenant>/<workflow>/<name>`; the `/trigger/*` handler becomes kind-aware and synthesizes the `HttpTriggerPayload` for HTTP descriptors; the handler captures the session user and passes it as dispatch.
- `dashboard-list-view`: invocation rows render a `manual by <name>` chip when the originating `trigger.request` carries `source: "manual"`.
- `event-store`: events table schema adds a nullable `meta JSON` column; archive loader tolerates missing `meta` on legacy entries.

SECURITY.md updates (new §2 R-rule restricting `meta` stamping to the executor; §4 note on the UI-reroute of HTTP-trigger fires) are task-level artifacts, not spec-level capability changes; they are captured in `tasks.md` and do not produce a spec delta.

## Impact

- **Code**: `packages/core/src/index.ts` (InvocationEvent type), `packages/runtime/src/executor/index.ts` (invoke signature + activeMeta + widener), `packages/runtime/src/triggers/build-fire.ts` (fire signature), `packages/runtime/src/triggers/http.ts` (webhook source passes no dispatch), `packages/runtime/src/triggers/cron.ts` (cron source passes no dispatch), `packages/runtime/src/ui/trigger/middleware.ts` (kind-aware HTTP wrapping + session → dispatch), `packages/runtime/src/ui/trigger/page.ts` (HTTP submitUrl flips to `/trigger/*`), `packages/runtime/src/event-bus/event-store.ts` (new `meta` column + serialization), `packages/runtime/src/ui/dashboard/middleware.ts` + `page.ts` (fetch `meta`, render chip), SECURITY.md (§2 new R-rule + §4 note).
- **APIs**: internal runtime contract only. Tenant-facing SDK is unchanged. Workflow authors do not see `dispatch`. External `/webhooks/*` callers see no behavior change.
- **Storage**: events table gains one nullable column; archive JSON files gain an optional `meta` top-level field. Loader tolerates absence — no `pending/` or `archive/` wipe required. Legacy events load with `meta = null`.
- **Deploy**: no tenant re-upload required (SDK surface unchanged); no state wipe; no manifest change.
- **Security**: new invariant documented. The reroute of HTTP UI fires is a defense-in-depth improvement — unauthenticated UI fires of HTTP triggers were previously possible via the public webhook URL; they now require session + tenant membership.
