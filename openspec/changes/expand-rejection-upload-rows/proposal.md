## Why

Today the invocations list shows `trigger.rejection` and `system.upload` rows non-expandable, with a small `<title>` tooltip as the only inspection surface. The first Zod issue on a rejection, or the uploader login on an upload, is visible — but the rest of the event payload (full issues array, HTTP method/path, bundle metadata, dispatch user mail, `workflowSha`) is unreachable from the UI. Users debugging a misbehaving webhook caller, or auditing who uploaded which bundle, must drop into the EventStore directly.

## What Changes

- `trigger.rejection` and `system.upload` rows in the invocations list become expandable `<details>` rows with the same chevron/affordance used by real terminal rows. The existing `<title>` tooltip on the rejected/upload pill is preserved for at-a-glance.
- A new endpoint `GET /invocations/:owner/:repo/:id/event` returns an HTML fragment containing the full EventStore row for the invocation, rendered as a single collapsible JSON tree via the shared `wfeRenderJsonTree` renderer. The fragment is fetched on first expand via htmx (`hx-get` on the `<details>` element), mirroring the flamegraph-fragment pattern.
- The `/event` endpoint is restricted to single-leaf rows of kinds `trigger.rejection` and `system.upload`. Real paired-bar rows, `trigger.exception` rows, unknown ids, and non-member callers all receive `404 Not Found` (enumeration-prevention pattern, identical to the flamegraph endpoint).
- **BREAKING for spec only:** `GET /invocations/:owner/:repo/:id/flamegraph` now responds `404 Not Found` for synthetic single-leaf rows (was: `FlameEmpty` "No flamegraph available for this invocation."). No internal caller is affected — the flamegraph affordance is only emitted on rows that have a paired `trigger.request`. This keeps the two endpoints' enumeration semantics symmetric.
- `trigger.exception` rows remain non-expandable. They surface server-internal trigger setup failures (IMAP misconfig, HTTP response-header strip, etc.), are not user-actionable in the same way as caller-driven rejections or uploads, and the existing tooltip on the "trigger setup failed" pill stays as the only inspection surface.
- The unimplemented `Synthetic-row expansion renders instant marker` requirement (currently in `invocations-list-view`) is removed. The instant-marker code path was never wired up — `computeLayout` returns null for synthetic rows, the `/flamegraph` route returns `FlameEmpty`, and no test exercises the path. The new event-detail fragment supersedes it.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `invocations-list-view`: synthetic `trigger.rejection` and `system.upload` rows gain an expand affordance and an event-detail fragment endpoint; the unimplemented instant-marker scenario for synthetic rows is removed; `trigger.exception` rows are explicitly excluded from the expand affordance; the flamegraph endpoint's behavior for synthetic ids is tightened to `404`.

## Impact

- **Code**:
  - `packages/runtime/src/ui/invocations/page.tsx` — `noFlamegraph` flips for `trigger.rejection` and `system.upload` (still excludes `trigger.exception` and `pending`); rows of those two synthetic kinds render as `<details>` with `hx-get` on `/event`.
  - `packages/runtime/src/ui/invocations/middleware.tsx` — register `GET /:owner/:repo/:id/event` before the 4-segment trigger-filter route (same ordering trick the flamegraph route uses); look up the row by id under `(owner, repo)`, branch on kind, return `404` for non-eligible kinds.
  - New fragment renderer that emits a JSON tree using `window.wfeRenderJsonTree` (the existing `/static/json-tree.js` renderer that the result-dialog already uses).
  - `flamegraph` handler — for synthetic single-leaf rows, switch from `FlameEmpty` to `404`.
- **Specs**: `openspec/specs/invocations-list-view/spec.md` — modified requirements (expandable rows, expand affordance, single-leaf inline rows, flamegraph fragment endpoint), one removed requirement (synthetic-row instant marker), one added requirement (event-detail fragment endpoint).
- **Tests**: `packages/runtime/src/ui/invocations/middleware.test.ts` extends synthetic-row group with affordance and `hx-get` URL assertions, plus a new describe for `/event` covering both eligible kinds, the three 404 paths (real row, exception, non-member), and the flamegraph-now-404-for-synthetic edge.
- **Security**: no new authentication surface; `/event` inherits `requireOwnerMember()` from `/:owner/*` along with the rest of the invocations app. Lossless rendering is safe under the existing EventStore governance: `trigger.rejection.input` deliberately omits caller body (http.ts:262 — "caller bodies are untrusted and may carry PII"), so the persisted row is already designed to be UI-renderable.
- **Docs**: no changes to `docs/`. `demo.ts` already produces both kinds via the existing `fail` manualTrigger and the canonical webhook trigger with a strict zod body — dev-probes can hit a webhook with a bad payload to produce a `trigger.rejection` row on demand.
- **APIs / dependencies**: no new dependencies. No manifest format change. EventBus consumer pipeline unchanged.
