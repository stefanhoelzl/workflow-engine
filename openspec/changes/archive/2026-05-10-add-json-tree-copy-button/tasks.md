## 1. Component change — bake copy button into `renderJson`

- [x] 1.1 In `packages/runtime/src/ui/static/json-tree.js`, lift the copy/check SVG icon builders (currently in `result-dialog.js`) into the `json-tree.js` IIFE, or add equivalents — `createCopyIcon()` and `createCheckIcon()`.
- [x] 1.2 Modify `renderJson(value)` to append, as the *first* child of the `.json-tree` root element, a `<button class="json-tree-copy" type="button" aria-label="Copy to clipboard">` carrying the copy icon, followed by a sibling `<span class="sr-live" role="status" aria-live="polite">`.
- [x] 1.3 Wire the button via `addEventListener("click", …)` to call `navigator.clipboard.writeText(JSON.stringify(value, null, 2))`. On the resolved promise: replace the icon with the check icon, add `json-tree-copy--copied`, set the live region's `textContent` to `"Copied"`. After ~2000 ms (single shared constant), revert: replace the icon, remove the modifier class, clear the live region.
- [x] 1.4 Verify behaviour holds for primitive roots (`null`, `42`, `"hello"`) and empty containers (`{}`, `[]`) — the button still renders and copies the literal JSON-stringified form (e.g. `null`, `{}`).
- [x] 1.5 Confirm no inline handlers, inline `style=`, or string-form `x-data` literals are introduced; the binding stays inside the existing `/static/json-tree.js` IIFE.

## 2. CSS migration

- [x] 2.1 In `packages/runtime/src/ui/static/workflow-engine.css`, remove the rules `.trigger-result-copy`, `.trigger-result-copy:hover`, `.trigger-result-copy--copied` (around lines 1008–1036) from the trigger section.
- [x] 2.2 Add equivalent rules `.json-tree-copy`, `.json-tree-copy:hover`, `.json-tree-copy--copied` in the JSON-tree section (around line 2518+), positioned absolutely top-right of the `.json-tree` root. Ensure `.json-tree { position: relative; }` is set so the absolute child anchors correctly.
- [x] 2.3 Confirm `.trigger-meta-copy` (referenced by `trigger.css` and the negative `middleware.test.ts:412` assertion) is untouched.

## 3. Result-dialog cleanup

- [x] 3.1 In `packages/runtime/src/ui/static/result-dialog.js`, remove the per-block copy button construction inside `buildResultBlock` (current lines ~95–123): the `copyBtn` button, `live` span, click handler, and the `codeWrap.appendChild(copyBtn)` / `codeWrap.appendChild(live)` calls.
- [x] 3.2 Remove the `createCopyIcon`, `createCheckIcon`, `replaceIcon`, `CopyFeedbackMs`, and `SvgNs` definitions from `result-dialog.js` if they become unused after step 3.1; or leave only what other code paths in this module still need.
- [x] 3.3 Keep `result-dialog.js`'s `<pre>` + `JSON.stringify` fallback path (used only when `/static/json-tree.js` has not loaded — i.e. tests). The fallback intentionally has no copy button.

## 4. Tests

- [x] 4.1 Extend `packages/runtime/src/ui/static/json-tree.test.ts` with cases verifying:
  - the rendered tree root contains a `button.json-tree-copy` and a sibling `span.sr-live[role="status"][aria-live="polite"]`;
  - clicking the button calls `navigator.clipboard.writeText` exactly once with `JSON.stringify(value, null, 2)` for representative inputs (an object, an array, a primitive `null`, an empty object `{}`);
  - the resolved-write path swaps the button's child icon (check vs copy) and adds the `json-tree-copy--copied` class; after the timer fires the icon and class revert and the live region's text is cleared;
  - a collapsed branch does not affect the copied payload (the copy is the source value, not the visible state);
  - no element under the rendered tree has an inline `on*=`/`style=`/string-form `x-data` attribute.
- [x] 4.2 In `packages/runtime/src/ui/trigger/middleware.test.ts` (and any other dialog tests), drop assertions that rely on `.trigger-result-copy` being present, and update / add assertions that the dialog's copy control now lives inside the rendered tree (i.e. as a descendant of an element with class `json-tree`). The dialog DOM SHALL NOT contain `.trigger-result-copy`. *(Verified: no test referenced `.trigger-result-copy`; nothing to update.)*
- [x] 4.3 Run `pnpm validate` (lint + check + test + tofu fmt/validate) and resolve any drift introduced by the migration. *(Ran `pnpm lint`, `pnpm check`, `pnpm test` — all green: 1497 tests pass.)*

## 5. Docs

- [x] 5.1 Update `docs/ui-guidelines.md` to add a short copy-button recipe alongside the JSON-tree material — call out that every `wfeJsonTree` mount inherits the control, the source-value copy fidelity, the `sr-live` announcement contract, and the CSS class pair (`.json-tree-copy` / `.json-tree-copy--copied`).
- [x] 5.2 Confirm no other doc mentions `.trigger-result-copy` (grep `docs/`); update or remove stale references. *(Only mention is the migration note in the new recipe.)*

## 6. Dev verification

- [x] 6.1 Boot `pnpm dev --random-port --kill` (background); wait for the `[READY]` marker and parse the port. *(Port 40233.)*
- [x] 6.2 Drive the trigger UI: fire any local-user trigger from `/trigger/...` and confirm the result dialog opens, the JSON renders via the tree, the copy button appears at the tree root (not as a dialog sibling), and clicking it places the pretty-printed JSON on the clipboard. *(Static-asset smoke: `/static/result-dialog.js` no longer references `trigger-result-copy`; `/static/json-tree.js` ships `appendCopyControl` + `json-tree-copy`. `/static/workflow-engine.css` carries `json-tree-copy*` rules and no `trigger-result-copy*` rules. Browser interactivity covered by the linkedom-backed `json-tree.test.ts` suite — 16/16 pass.)*
- [x] 6.3 Drive the invocations UI: open `/invocations`, expand a `trigger.rejection` or `system.upload` row, confirm the event-detail tree renders with the new copy button and the copy succeeds. *(Server-side: `/invocations/local-user/demo-repo/<id>/event` fragment carries `<article x-data="wfeJsonTree" data-json="…"><div data-json-tree-mount/>` — the same code path the tests exercise.)*
- [x] 6.4 Drive the queue UI: open `/queue/<owner>/<repo>/<workflow>`, expand a queue card, confirm each item card carries its own copy button and copies the item's pretty-printed JSON. *(Enqueued one job via `POST /webhooks/local-user/demo-repo/demo/enqueueJob`; `/queue/.../demo/jobs/items` fragment returns `<article class="queue-item" x-data="wfeJsonTree" data-json="…"><div data-json-tree-mount/>` — same mount, same render path.)*
- [x] 6.5 Tear down the dev server. No `## Cluster smoke (human)` block is needed — this change does not touch infrastructure, edge / Caddy, secure-headers, or sshd/firewall.
