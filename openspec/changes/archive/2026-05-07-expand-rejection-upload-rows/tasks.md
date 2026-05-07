## 1. Endpoint — `GET /:owner/:repo/:id/event`

- [x] 1.1 Register the route in `packages/runtime/src/ui/invocations/middleware.tsx` BEFORE the 4-segment `/:owner/:repo/:workflow/:trigger` filter route, mirroring the placement comment used for the `/flamegraph` route ("Hono's matcher resolves … to this literal-tail route rather than to the trigger filter").
- [x] 1.2 Implement the handler: read the invocation's events via `eventStore.query([{owner, repo}]).where('id', '=', id).orderBy('seq', 'asc').execute()`. If zero events, respond `404 Not Found` with the same shape used by `createNotFoundHandler()`.
- [x] 1.3 Inspect the loaded events and respond `404 Not Found` when the row is not a single-leaf invocation of kind `trigger.rejection` or `system.upload` (i.e. `events.length !== 1` OR `events[0].kind !` ∈ `{trigger.rejection, system.upload}`). The handler MUST NOT distinguish "wrong kind" from "no such id" in the response.
- [x] 1.4 For an eligible row, render the fragment via a new `renderEventDetail(event)` helper (alongside `renderFlamegraph`). The fragment outputs an outer container with the same `<details>`-body class hook the flamegraph fragment uses (so the existing `<details><div class="flame-slot" />` swap target works for both endpoints) and an inline script-free placeholder element that the client-side `json-tree.js` enhances by replacing its `data-json` attribute via `window.wfeRenderJsonTree(JSON.parse(el.dataset.json))`. JSON serialization SHALL include every persisted EventStore column for the row (lossless).
- [x] 1.5 Confirm the route is covered by `requireOwnerMember()` (already applied via `app.use("/:owner/:repo/*", requireOwnerMember())` in `invocationsMiddleware`) — no per-route auth wiring needed.

## 2. Endpoint — `GET /:owner/:repo/:id/flamegraph` 404 for synthetic ids

- [x] 2.1 In the existing flamegraph handler in `middleware.tsx`, after `fetchInvocationEvents`, detect the synthetic single-leaf case (`events.length === 1` AND `events[0].kind` ∈ `{trigger.exception, trigger.rejection, system.upload}`) and respond `404 Not Found` (same shape as the no-events 404).
- [x] 2.2 Verify the existing `FlameEmpty` SSR rendering in `flamegraph.tsx` is no longer reachable via the route: it remains as a defensive fallback for a `null` layout produced by other reasons (e.g. malformed event sequences) but the `404` short-circuits the synthetic-id case before `renderFlamegraph` is called.

## 3. Row affordance — `page.tsx`

- [x] 3.1 Update `noFlamegraph` in `Row` (`packages/runtime/src/ui/invocations/page.tsx`) to flip `trigger.rejection` and `system.upload` out of the no-expand list, retaining `pending` and `trigger.exception`.
- [x] 3.2 For expandable rows, compute the fragment URL per kind: real paired rows → `/invocations/<owner>/<repo>/<id>/flamegraph`; `trigger.rejection` and `system.upload` rows → `/invocations/<owner>/<repo>/<id>/event`. Apply the chosen URL as the `<details>` element's `hx-get` attribute.
- [x] 3.3 Ensure `RowCells expandable={true}` continues to render the chevron affordance for the newly-expandable synthetic kinds. Confirm via the existing CSS rule (`[open] > summary <affordance>`) that the rotation transition still applies.
- [x] 3.4 Preserve the existing `MetaCell` tooltip behavior for `trigger.rejection` (`rejectionSummary`) and `system.upload` (uploader login + mail). The expand affordance is additive; the tooltip is unchanged.

## 4. JSON tree fragment renderer

- [x] 4.1 Add a thin `renderEventDetail(event)` SSR function in a new module `packages/runtime/src/ui/invocations/event-detail.tsx` (sibling to `flamegraph.tsx`). The function emits an HTML fragment containing a single `<div class="event-detail">` whose `data-json` attribute carries the JSON-serialized event row.
- [x] 4.2 Extend `/static/json-tree.js` (or add a small companion `/static/event-detail.js` if cleaner) so the client mounts `window.wfeRenderJsonTree(JSON.parse(el.dataset.json))` into any `.event-detail[data-json]` element on `htmx:afterSwap`. Reuse the existing renderer; do NOT duplicate JSON-tree logic.
- [x] 4.3 Add a CSS rule pair to `packages/runtime/src/ui/static/workflow-engine.css` (or the file co-located with the existing flame-fragment styles) so the event-detail block has consistent padding and `max-height` with the flamegraph block (a row-level `.flame-slot` neighbour). No new CSS tokens.

## 5. Tests — `middleware.test.ts`

- [x] 5.1 Extend the existing `dashboard middleware — single-leaf trigger.rejection invocations` describe (or add sibling describes) to assert: (a) the rendered HTML contains `details` for the row, (b) the row's summary includes `aria-label="trigger rejected"` (existing assertion, kept), (c) the row's `details` element carries `hx-get="/invocations/.../event"`, (d) the row carries an expand chevron.
- [x] 5.2 Add a sibling describe for `single-leaf system.upload invocations` asserting the same expand affordance + `hx-get="/invocations/.../event"` URL on `<details>`.
- [x] 5.3 Confirm the `trigger.exception` row continues to render NO `<details>` wrapping and NO `hx-get`. Add a regression assertion if not already present.
- [x] 5.4 Add a new describe for `GET /:owner/:repo/:id/event`. Cases: (a) eligible `trigger.rejection` id → 200 + fragment contains `data-json` attribute whose decoded JSON includes `kind`, `name`, `at`, `input.issues`; (b) eligible `system.upload` id → 200 + fragment contains decoded `meta.dispatch.user.login`, `meta.workflowSha`; (c) real paired-bar id → 404; (d) `trigger.exception` id → 404; (e) unknown id → 404; (f) non-member → 404 (use the existing non-member auth fixture). All four 404 responses MUST share a body shape (assert via byte-equality or structural match).
- [x] 5.5 Add a regression case to the existing flamegraph describe: requesting `/flamegraph` for a synthetic single-leaf id of each of the three kinds returns 404 (was: `FlameEmpty` "No flamegraph available for this invocation.").

## 6. Dev-probes — `tasks.md` of the change is the source

- [x] 6.1 In `pnpm dev`, identify or create a webhook trigger backed by a strict zod body schema (the canonical demo webhook qualifies). Hit it with a deliberately-bad payload using `curl -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:<port>/webhooks/local-user/demo-repo/...` and confirm a `trigger.rejection` row appears in `/invocations`.
- [x] 6.2 Click the rejection row's chevron in a browser and confirm the inline expansion renders the JSON tree of the rejection event with `input.issues`, `input.method`, `input.path`, `at`, `id`, `kind = "trigger.rejection"`, `name = "http.body-validation"`.
- [x] 6.3 Click the upload row chevron (every `pnpm dev` boot uploads `demo.ts` so a `system.upload` row exists by default) and confirm the JSON tree includes `meta.dispatch.user.login = "local-user"`, `meta.dispatch.user.mail` (when present), and `meta.workflowSha`.
- [x] 6.4 Confirm the `trigger.exception` row (produced by the IMAP misconfig path or any handy synthetic `trigger.exception` event already present on `pnpm dev` boot) does NOT show a chevron and clicking it does not initiate an HTMX fetch (network panel shows no `/event` request).
- [x] 6.5 Confirm `curl http://localhost:<port>/invocations/local-user/demo-repo/<rejection-id>/flamegraph` returns 404 (was: empty fragment with `flame-empty` class).

## 7. Validation — pre-merge

- [x] 7.1 `pnpm validate` passes (lint + check + test + tofu fmt/validate).
- [x] 7.2 `pnpm exec openspec validate expand-rejection-upload-rows --strict` passes.
- [x] 7.3 No new `biome-ignore` directive added without a justifying suffix.
- [x] 7.4 No new CSP-incompatible markup (no inline `<script>`/`<style>`/`on*=`/`style=`/`x-data=` literal). The new `data-json` attribute is read by `/static/json-tree.js` via `dataset` lookup — pre-existing pattern.
