## Why

The trigger-fire result dialog has a copy-to-clipboard button on every JSON payload it renders, but the same JSON values shown elsewhere — expanded invocation event-detail rows and queue items — have no copy affordance. Users inspecting an event row or a queued item have to hand-select the rendered text (lossy, picks up tree punctuation/indent artefacts) or open devtools to grab the underlying JSON. Since all three surfaces already render through the same shared JSON-tree component, the right fix is to give the component itself a copy button so every current and future mount inherits the affordance.

## What Changes

- The shared interactive JSON-tree component (`renderJson` in `packages/runtime/src/ui/static/json-tree.js`) renders a copy-to-clipboard button at the root of every tree it produces. Clicking copies `JSON.stringify(value, null, 2)` of the original value to the clipboard, swaps the button icon to a checkmark, and announces "Copied" to assistive tech via an `sr-live` region. After ~2s the button reverts.
- The trigger-fire result dialog (`result-dialog.js`) drops its per-block `.trigger-result-copy` button — the tree's own button now provides the affordance. Each labelled block still gets exactly one copy button (now inside the tree).
- CSS rules currently named `.trigger-result-copy` / `.trigger-result-copy--copied` move from the trigger section of `workflow-engine.css` to the JSON-tree section and rename to `.json-tree-copy` / `.json-tree-copy--copied`.
- The unrelated `.trigger-meta-copy` class (for copying webhook URLs on the trigger meta strip) is unaffected.
- **Non-goals**: per-list aggregate copy button covering all queue items at once; per-row copy on individual JSON nodes; copying the tree's *visible* (collapsed-aware) state instead of the source value.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `ui-foundation`: the "Shared interactive JSON-tree component" requirement gains a new invariant — a copy-to-clipboard control with a defined payload contract and an `sr-live` success announcement.
- `trigger-ui`: the "Result dialog renders payloads via the shared JSON tree" requirement is clarified — the copy-to-clipboard control is provided by the shared JSON-tree component, not as a sibling of the rendered payload. The CSS class reference moves from `.trigger-result-copy` to `.json-tree-copy`.

## Impact

- **Code**: `packages/runtime/src/ui/static/json-tree.js` (add button + `sr-live` to `renderJson`); `packages/runtime/src/ui/static/result-dialog.js` (drop per-block copy button); `packages/runtime/src/ui/static/workflow-engine.css` (move + rename copy-button rules); `packages/runtime/src/ui/static/json-tree.test.ts` (new tests for the button); `packages/runtime/src/ui/trigger/middleware.test.ts` (drop `.trigger-result-copy` assertions where they exist).
- **Docs**: `docs/ui-guidelines.md` gains a copy-button recipe note alongside the existing JSON-tree material.
- **Surfaces gaining the affordance**: trigger result dialog (already had it; now via the tree), invocations event-detail expanded rows, queue item cards. Any future `wfeJsonTree` mount automatically inherits it.
- **CSP / Permissions-Policy**: no change — `clipboard-write=(self)` is already allowed (`packages/runtime/src/services/secure-headers.ts:62`); rendering uses the existing `Alpine.data` + `addEventListener` pattern with no new inline handlers, scripts, or styles.
- **APIs / dependencies / sandbox boundary / EventBus / manifest**: unaffected. This is a pure authenticated-UI change.
