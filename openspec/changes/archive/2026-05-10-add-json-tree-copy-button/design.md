## Context

Three authenticated UI surfaces render JSON values:

| Surface | Mount mechanism | Source value |
| --- | --- | --- |
| Trigger result dialog (`result-dialog.js`) | imperative call to `window.wfeRenderJsonTree(payload)` | live JS value built by `trigger-forms.js` from the `fetch` response |
| Invocations event-detail expanded row (`event-detail.tsx`) | `<article x-data="wfeJsonTree" data-json={…}>` swapped in by htmx, picked up by `Alpine.initTree` | EventStore row pre-stringified server-side via `JSON.stringify(event, bigintReplacer)` |
| Queue items fragment (`queue/page.tsx`) | `<article x-data="wfeJsonTree" data-json={…}>` injected by the `wfeQueueCard` lazy loader | queue item pre-stringified server-side |

All three converge on `renderJson(value)` in `packages/runtime/src/ui/static/json-tree.js` — either by direct call (the dialog) or via the `wfeJsonTree` Alpine factory which calls `renderJson` after JSON-parsing `data-json`.

Today only the dialog has a copy-to-clipboard button. It lives at the block level (`.trigger-result-copy`, absolutely positioned in `.trigger-result-code`) and is built per-block in `result-dialog.js` (lines 95–123). The other two surfaces have nothing.

The `ui-foundation` capability already specifies this component (`openspec/specs/ui-foundation/spec.md` § "Shared interactive JSON-tree component", line 234) with invariants for default expansion, CSP-clean rendering, keyboard activation, theme respect, and reduced motion. Copy-to-clipboard is currently described as part of the `trigger-ui` capability, attached to the dialog rather than the tree.

The Permissions-Policy already grants `clipboard-write=(self)` (`packages/runtime/src/services/secure-headers.ts:62`).

## Goals / Non-Goals

**Goals:**
- Every JSON-tree mount in the authenticated UI carries its own copy-to-clipboard button without per-call-site wiring.
- The button copies the *original* value passed to `renderJson` (after pretty-printing with 2-space indent), preserving JSON fidelity rather than reflecting the visible/collapsed DOM state.
- Screen-reader users hear "Copied" on success via an `sr-live` region.
- The trigger-fire result dialog stops owning a separate copy button — single source of truth.
- The `ui-foundation` spec gains the copy-button invariant; the `trigger-ui` spec is updated to reflect that the control is now provided by the shared tree.
- No CSP / inline-handler regressions. No new asset, no new external dependency.

**Non-Goals:**
- A per-list aggregate copy button (e.g. one button copying all queue items as an array). Distinct feature; not a substitute.
- Per-row / per-node copy buttons inside the tree (copying only a sub-tree). Different UX and out of scope.
- Copying the visible (collapsed-aware) representation. Always copy the source value.
- Touching the unrelated `.trigger-meta-copy` class (used for copying webhook URLs on the trigger meta strip — currently dead CSS with no JS user, irrelevant here).
- Changes to sandbox surface, EventBus pipeline, manifest format, or the `clipboard-read` Permissions-Policy entry.

## Decisions

### Decision 1: Bake the button into `renderJson` rather than each call-site

`renderJson(value)` is the single render entry point used by all three surfaces (directly by `result-dialog.js`, indirectly via the `wfeJsonTree` Alpine factory by event-detail and queue items). Adding the button there gives every current and future mount the affordance for free, and matches the existing spec direction (`ui-foundation` already pulls invariants up to the component level).

Alternatives considered:

| Option | Verdict |
| --- | --- |
| **Per-call-site, like `result-dialog.js` today** | Rejected. Three duplicate implementations, easy to drift. Result-dialog's button works only because it can wrap the tree in extra DOM (`.trigger-result-block` / `.trigger-result-code`); the htmx and queue surfaces don't have analogous wrappers. |
| **Extract `/static/copy-button.js` shared by `result-dialog.js` and `json-tree.js`** | Rejected for a feature this small. Adds a script-load ordering constraint and an extra file. The tree is already a coherent component; the button belongs to it. |
| **Bake into `renderJson` (chosen)** | One change site, one CSS section, one test target. |

### Decision 2: Copy the *source* value, not the rendered DOM text

The click handler captures `value` (the parameter to `renderJson`) in a closure and serialises with `JSON.stringify(value, null, 2)`. This is what `result-dialog.js` does today (line 109) and matches user expectation: copying gives you valid JSON regardless of whether the tree is currently collapsed.

For the htmx and queue surfaces, the value reaching `renderJson` has already been round-tripped through `JSON.stringify`/`JSON.parse` via the `data-json` attribute; in the event-detail case `bigintReplacer` (`event-detail.tsx:3`) widens any `bigint` columns to `Number` first. The copied text therefore reflects the post-replacer value — the same value the tree displays. This is a property of the existing data flow, not a change.

### Decision 3: Render the button as a child of `.json-tree`, absolutely positioned top-right

```
<div class="json-tree">
  <button class="json-tree-copy" aria-label="Copy to clipboard">[svg copy icon]</button>
  <span class="sr-live" role="status" aria-live="polite"></span>
  <div class="json-tree-row" data-depth="0">…</div>
  …
</div>
```

The button is a sibling of the rows inside the `.json-tree` root rather than a wrapper. This:
- preserves the existing `.json-tree-row` indent math (`data-depth` driven CSS padding) — no row gets shifted;
- works for a primitive root (one-row tree) and for empty containers (`{}` / `[]`) without special cases;
- mirrors `.trigger-result-copy`'s current absolutely-positioned-top-right pattern, so the visual treatment is preserved when CSS migrates.

The icon-swap, `--copied` modifier class, and 2000ms revert are reused verbatim from `result-dialog.js`. The `sr-live` element is a sibling, not inside the button, so the polite live-region behavior matches what the dialog already ships.

CSS rules currently `.trigger-result-copy` / `.trigger-result-copy:hover` / `.trigger-result-copy--copied` move to `.json-tree-copy*` and live in the existing JSON-tree section of `workflow-engine.css` (lines 2518+).

### Decision 4: Result dialog drops its per-block copy button entirely

`result-dialog.js`'s `buildResultBlock` function loses lines 95–123 (button + `sr-live` construction and the click handler). The dialog still renders one block per labelled payload, each block contains exactly one tree, each tree now contains exactly one button — so per-block copy parity is preserved, and no block-level copy fallback (e.g. for the `<pre>` fallback path when `wfeRenderJsonTree` is not loaded) is needed. The fallback path exists only for tests that do not load `/static/json-tree.js` and is not user-facing.

### Decision 5: Spec deltas split between `ui-foundation` and `trigger-ui`

Two specs already touch this area. The split:

- **`ui-foundation`** owns the new invariant: *the JSON-tree component renders a copy-to-clipboard control that copies the source value, with sr-live success announcement*. This is part of the component's contract, applies to all consumers, and slots next to the existing default-expansion / CSP / keyboard / theme / motion invariants.
- **`trigger-ui`** owns the clarification on the result-dialog requirement: *the copy-to-clipboard control is provided by the shared JSON-tree component, not as a dialog-level sibling*. The dialog requirement still mandates the affordance, just sourced from the tree.

Each delta carries its scenarios. The proposal lists both capabilities as Modified.

## Risks / Trade-offs

- **Test coupling on `.trigger-result-copy`** → Mitigation: grep the test tree before deleting/renaming. Only `middleware.test.ts:412` mentions the related `.trigger-meta-copy` (negative assertion, untouched). The migration of `.trigger-result-copy` → `.json-tree-copy` is mechanical; tests that asserted its presence get updated to assert `.json-tree-copy` (and now appear inside the tree, not as a dialog sibling).
- **Stacking many buttons in queue lists** → Mitigation: this is the intended UX (per-tree granularity matches "copy this item"). Documented as a non-goal not to introduce a per-list aggregate; users wanting "all items as JSON" use the underlying API. Visual density is bounded by the existing items-per-page cap (50, see `queues-ui/spec.md`).
- **CSP regression** → Mitigation: the button is created via `document.createElement` and wired with `addEventListener` inside the existing `json-tree.js` IIFE — no inline handlers, scripts, or styles introduced. The existing `wfeJsonTree` registration path already satisfies the CSP-clean invariant; this addition stays inside that path.
- **Permissions-Policy regression** → Mitigation: `clipboard-write=(self)` is already allowed (`secure-headers.ts:62`, asserted in `secure-headers.test.ts:92`). No header change needed.
- **Fallback `<pre>` path in `result-dialog.js` loses copy** → Acceptable. The fallback is reached only when `/static/json-tree.js` has not loaded — i.e. test environments — and no human user encounters it.
- **`docs/ui-guidelines.md` drift** → Mitigation: the project convention (CLAUDE.md) requires `workflow-engine.css` PRs to keep `ui-guidelines.md` in sync. A small recipe entry for `.json-tree-copy` is part of the task list.
