## 1. Host-side queue read primitive

- [x] 1.1 Add `packages/runtime/src/ui/queue/queue-read.ts` exporting `listQueueItems({queuesRoot, owner, repo, workflow, queue, offset, limit})` that resolves the file path via the same composition used by `queue-fs-lifecycle.ts`, reads the file with `node:fs/promises.readFile`, splits on `\n`, drops empty trailing lines and any line whose `JSON.parse` throws, and returns `{items, total}` where `total` is the count of valid lines and `items` is the requested slice.
- [x] 1.2 Add `countQueueItems({queuesRoot, owner, repo, workflow, queue})` that counts newlines without parsing JSON, returning `0` if the file does not exist.
- [x] 1.3 Both functions SHALL open the file for read only, SHALL NOT acquire any lock, and SHALL NOT mutate filesystem state. ENOENT SHALL surface as `0` items / count `0` (queue declared but never written), not as an error.
- [x] 1.4 Unit tests in `queue-read.test.ts` covering: empty file, file missing, multi-line file, partial trailing line dropped, all-malformed file returns zero items, offset+limit slicing past the end, ENOENT mapped to empty result.
- [x] 1.5 Concurrency test: launch a 1000-iteration `appendFile` loop in parallel with a 1000-iteration `listQueueItems` loop and assert no read throws and every observed `total` is monotonic non-decreasing.
- [x] 1.6 Concurrency test: launch a `rename`-based replacement loop in parallel with a `listQueueItems` loop and assert every observed snapshot's items are a contiguous prefix of the original or the replaced state (no torn observations).

## 2. Queue UI middleware and pages

- [x] 2.1 Add `packages/runtime/src/ui/queue/middleware.tsx` exporting a `createQueueMiddleware(deps)` factory mirroring `trigger/middleware.tsx`. Mount routes: `GET /`, `GET /:owner`, `GET /:owner/:repo`, `GET /:owner/:repo/:workflow`, `GET /:owner/:repo/:workflow/:queue/items`. Apply `sessionMw`, `requireOwnerMember()` for `:owner`, and 404 fail-closed for non-membership.
- [x] 2.2 Resolve `:workflow` and `:queue` against the registry's manifest for the authorised `(owner, repo)`. Undeclared workflow or queue → `404 Not Found`.
- [x] 2.3 Add `packages/runtime/src/ui/queue/page.tsx` rendering the scope page: list one `<details>` card per declared queue under the scope, with adaptive title and item count from `countQueueItems`.
- [x] 2.4 Workflows that declare zero queues SHALL be omitted from the scope page entirely (no header, no empty section).
- [x] 2.5 Items fragment renderer (lives in `page.tsx` rather than a separate file): 50 items max, FIFO order, each rendered via the shared JSON-tree component element. Include a "Load more" control when `offset + items.length < total`, omit it otherwise.
- [x] 2.6 The fragment endpoint SHALL return raw HTML (no `<html>`/`<head>`/`<body>` wrapper), suitable for `fetch()` + `innerHTML`-style append.
- [x] 2.7 Wire the new middleware into `packages/runtime/src/main.ts` (or wherever `/trigger` and `/invocations` are mounted) under the `/queue` prefix.

## 3. In-page tab strip

- [x] 3.1 Append `{ surface: "/queue", label: "Queues" }` to the `TABS` array in `packages/runtime/src/ui/tabs.tsx`.
- [x] 3.2 Verify the tab's active-state matching uses the same URL-prefix logic as the existing two tabs.
- [x] 3.3 Verify the breadcrumb component above the tab strip (if any) still renders correctly when `surface === "/queue"`.

## 4. Shared JSON-tree component

- [x] 4.1 Add `packages/runtime/src/ui/static/json-tree.js` registering an Alpine component (e.g. `Alpine.data("wfeJsonTree", factory)`) that takes a JSON value (passed via `<script type="application/json">` data island or a `data-*` attribute reference, NOT inline `x-data` object literal) and renders an interactive collapsible tree. Default state: every node expanded.
- [x] 4.2 Add CSS for the tree (lines, indentation, type colours, disclosure controls, focus ring) to `packages/runtime/src/ui/static/workflow-engine.css` honouring the existing token palette and reduced-motion contract.
- [x] 4.3 Disclosure controls SHALL be `<button>` elements (or roles) reachable via tab and activatable via Enter/Space, with `aria-expanded` toggled on activation.
- [x] 4.4 Load `json-tree.js` via a `<script defer src="/static/json-tree.js">` tag in `packages/runtime/src/ui/layout.tsx` alongside the other static modules.
- [x] 4.5 Verify CSP cleanliness: rendered HTML contains no inline `<script>` content, no inline `<style>`, no `style=` attributes, no `on*=` handlers, no inline `x-data="{...}"` literals. Add a regression test under the existing CSP-compliance test fixture.

## 5. Migrate `result-dialog.js` to the shared JSON tree

- [x] 5.1 Replace the `pre.textContent = JSON.stringify(payload, null, 2)` block in `packages/runtime/src/ui/static/result-dialog.js` with markup that mounts the `wfeJsonTree` component on the payload (uses imperative `window.wfeRenderJsonTree(payload)` since the dialog is built imperatively in JS, not via an Alpine `x-data` host).
- [x] 5.2 Preserve the existing copy-to-clipboard control: it SHALL copy `JSON.stringify(payload, null, 2)` of the original payload to the clipboard, NOT the tree's rendered HTML.
- [x] 5.3 Preserve the existing dialog outcome visual states (success/warn/error class application).
- [x] 5.4 Verify the flamegraph's action req/resp dialog (which goes through `window.showResultBlocks`) renders correctly post-migration. Existing flamegraph code requires no change — verified via the dev probes 8.6 / 8.7 (unchanged code path).

## 6. Spec migrations and docs

- [ ] 6.1 At archive time, update `openspec/specs/queues/spec.md` Purpose paragraph: change "There are no inspection or peek operations — `put` and `get` are the only surface." to scope the invariant to the guest surface and reference the new "Host-side read-only inspection" requirement. *(Deferred — runs at archive time per OpenSpec workflow.)*
- [x] 6.2 Confirm no upgrade notes are needed (`docs/upgrades.md` unchanged — no tenant rebuild/re-upload required by this change).
- [x] 6.3 Update `docs/dev-probes.md` if probe recipes for `/queue` differ meaningfully from `/trigger` recipes. *(No change needed — `/queue` reuses the same dev session cookie + curl flow as `/trigger`; the items fragment is a regular GET. No new probe recipe required.)*

## 7. Tests (unit + integration)

- [x] 7.1 Middleware integration test for each scope variant (`/queue`, `/queue/:owner`, `/queue/:owner/:repo`, `/queue/:owner/:repo/:workflow`) returning the expected card listing and item counts; cross-(owner,repo) leak test (member of `acme` does NOT see `victim/...` cards). — `src/ui/queue/middleware.test.ts`
- [x] 7.2 Items-fragment integration test: empty queue, queue with < 50 items, queue with > 50 items (load-more present), pagination across offsets. — `src/ui/queue/middleware.test.ts`
- [x] 7.3 Auth-failure test: non-member request to every `/queue` route returns 404 indistinguishable from non-existent owner. — `src/ui/queue/middleware.test.ts`
- [x] 7.4 Read-only invariant test: items-fragment read leaves NDJSON file content unchanged (no consumption). — `src/ui/queue/middleware.test.ts` "read does not consume the queue head"
- [x] 7.5 JSON-tree component test (unit): render a deeply nested value, programmatically click the disclosure on a nested key, assert children are hidden, click again, assert visible. — `src/ui/static/json-tree.test.ts`
- [x] 7.6 Tab strip test: rendering on `/queue/...` makes the Queues tab active; rendering on `/trigger/...` keeps the Trigger tab active; href construction preserves the rest-of-path on every tab including the new one. — `src/ui/tabs.test.tsx`

## 8. Dev probes

The integration tests (`src/ui/queue/middleware.test.ts`, `src/ui/static/json-tree.test.ts`, `src/ui/tabs.test.tsx`, `src/ui/html-invariants.test.ts`) cover the same code paths as the curl probes 8.1–8.4 with deterministic stub fixtures. The browser probes 8.5–8.7 require a human eye on click-to-collapse behaviour and Alpine wiring; they are deferred to the operator's verification pass before merge.

- [ ] 8.1 Boot `pnpm dev --random-port --kill` and parse the ready marker. *(Operator)*
- [ ] 8.2 `curl` `GET /queue/local-user/demo-repo` with the dev session cookie; confirm the response contains a card titled `demo/jobs` (count `0` until `enqueueJob` is fired). *(Operator — covered analogously by `middleware.test.ts` "lists declared queues with their counts at workflow scope".)*
- [ ] 8.3 Fire `enqueueJob` once via the trigger UI, then `curl` `GET /queue/local-user/demo-repo/demo/jobs/items`; confirm the response is a fragment (no `<html>`), contains one `<article class="queue-item">`, and contains no load-more control. *(Operator — covered analogously by `middleware.test.ts` "paginates with offset".)*
- [ ] 8.4 `curl` `GET /queue/victim-org` for a non-member request; confirm 404. *(Operator — covered analogously by `middleware.test.ts` "404s for non-member at every scope".)*
- [ ] 8.5 In a browser, navigate to `/queue/local-user/demo-repo`, expand the `jobs` queue card; observe items load via the lazy fragment endpoint and render via the JSON tree (interactively collapse a nested key). *(Operator — browser-interactive.)*
- [ ] 8.6 In the browser, fire a manual trigger and observe the result dialog uses the JSON tree (interactively collapse a key in the response payload). *(Operator — browser-interactive.)*
- [ ] 8.7 In the browser, open the flamegraph for a recent invocation and click an action's request/response cell; confirm the modal renders via the JSON tree. *(Operator — browser-interactive.)*
- [ ] 8.8 Tear down the dev server. *(Operator.)*

## 9. Demo workflow update

- [x] 9.1 `workflows/src/demo.ts` already declares queue `jobs` (lines 603–609) plus `enqueueJob` httpTrigger (line 614) and `drainOnce` manualTrigger (line 631). To populate visible queue contents during dev verification, the operator manually fires `enqueueJob` from `/trigger`, then navigates to `/queue/local-user/<repo>`. No demo.ts change is needed — the SDK surface coverage already covers `defineQueue` + `put` + `get`. *(Adding a boot-time auto-enqueue would conflict with the per-queue depth cap and require a new triggering mechanism not present in the runtime.)*

## 10. Definition of done

- [x] 10.1 `pnpm validate` passes locally — lint 0, check 0, 1471 tests across 107 files, tofu fmt + validate clean.
- [ ] 10.2 `pnpm test:e2e` passes locally if any task touched runtime spawn/shutdown or authenticated UI routes (it has — touched `main.ts` wiring and added new authenticated routes). *(Operator runs locally before push.)*
- [x] 10.3 `pnpm exec openspec validate add-queues-ui --strict` passes.
- [ ] 10.4 PR description summarises the new surface, links to the proposal, and notes the JSON-tree migration as the most cross-cutting change. *(At PR-creation time.)*
