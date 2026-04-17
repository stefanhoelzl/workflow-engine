## 1. Flamegraph renderer (pure function)

- [x] 1.1 Create `packages/runtime/src/ui/dashboard/flamegraph.ts` exporting a `renderFlamegraph(events: InvocationEvent[]): string` factory that returns the full HTML fragment (summary + ruler + SVG) or the empty-state fragment when events is empty
- [x] 1.2 Implement main-tree layout: build the ref-graph, assign depth-based rows, overlap-stack siblings at the same depth
- [x] 1.3 Implement timer-track layout: collect all `timer.request` events (ref=null) as track roots, assign each to a track row, overlap-stack, recursively lay out their subtrees below
- [x] 1.4 Implement bar positioning: percentage-based `x` and `width` from `event.ts` relative to `trigger.response.ts` (or `trigger.error.ts`); apply the minimum-width floor for sub-µs bars
- [x] 1.5 Emit kind CSS classes (`kind-trigger`, `kind-action`, `kind-system`, `kind-timer`) and add `bar-error` + error icon child for `*.error` terminals
- [x] 1.6 Implement orphan-bar rendering: request events whose response is missing extend to `trigger.error.ts` with the `orphan` class
- [x] 1.7 Emit instant markers: `timer.set` as solid teal rect with `marker-set` class, `timer.clear` as `marker-clear-bg` rect plus two `marker-x` lines forming a `×`, `system.call` as a small marker distinct from timer markers; auto-clears (`ref=null` on `timer.clear`) get `marker-auto` class and render on row 0
- [x] 1.8 Emit timer connector paths: one `<path class="timer-connector" data-timer-id="N">` per (`timer.set`, `timer.request`) pairing correlated by `input.timerId`; zero paths for unpaired sets; N paths for setInterval with N fires
- [x] 1.9 Attach `data-timer-id` to every timer-related SVG element (set markers, clear markers including both `<line>`s, timer bars, connectors); non-timer elements get no `data-timer-id`
- [x] 1.10 Attach `data-event-pair="<reqSeq>-<resSeq>"` to paired bars and `data-event-seq="<seq>"` to instant markers so the static JS can look up the matching event records
- [x] 1.11 Render summary line (workflow · trigger · smart-unit duration · N actions · M host calls · status) and horizontal ruler (≥4 monotonic tick labels in smart-unit format) as text-layer elements rendered *after* all rects/paths so text always wins z-order
- [x] 1.12 Wrap the SVG in a container with the `max-height: 40vh; overflow-y: auto` class hook and set `<svg width="100%">` with a numeric pixel `height`
- [x] 1.13 Unit test the renderer with fixture event arrays covering: canonical trigger→action→system tree; orphan request; errored bar; single setTimeout fire (1 connector); setInterval fire×3 (3 connectors); unpaired set (no connector); nested timer (set inside callback); concurrent timers with overlap; empty input array → empty-state fragment

## 2. Fragment endpoint

- [x] 2.1 Add a `GET /dashboard/invocations/:id/flamegraph` route to `packages/runtime/src/ui/dashboard/middleware.ts`
- [x] 2.2 Handler calls `eventStore.query.where('id', '=', id).orderBy('seq', 'asc').execute()` with no id validation; if the result is empty, return the empty-state fragment; otherwise return `renderFlamegraph(events)`
- [x] 2.3 Always respond with HTTP `200` regardless of whether the id resolves (unknown, malformed, or pending ids all get the empty-state fragment)
- [x] 2.4 Log each request at `debug` level (not `info`) with the invocation id, to avoid flooding ops logs when operators expand many rows
- [x] 2.5 Middleware tests: valid completed id → SVG fragment; unknown id → empty-state fragment with 200; pending id (only `trigger.request`, no response) → empty-state fragment with 200; id with URL-encoded characters → empty-state with 200 (parameterized query handles it)

## 3. List-view row expansion

- [x] 3.1 Modify `renderInvocationList` in `packages/runtime/src/ui/dashboard/page.ts` so succeeded and failed invocation rows wrap in `<details>` with `hx-get="/dashboard/invocations/<id>/flamegraph"`, `hx-trigger="toggle once"`, `hx-target="find .flame-slot"`, and `hx-swap="innerHTML"`
- [x] 3.2 Include a `<div class="flame-slot"></div>` inside each `<details>` as the HTMX target
- [x] 3.3 Pending invocation rows render without `<details>` (no expand affordance)
- [x] 3.4 Ensure the summary row inside `<summary>` still contains the existing workflow/trigger/status/startedAt/duration fields so the unexpanded view is unchanged
- [x] 3.5 Tests: succeeded row contains `<details>` with the correct HTMX attrs; failed row same; pending row contains no `<details>`; existing list rendering scenarios remain green

## 4. Static CSS

- [x] 4.1 In `packages/runtime/src/ui/static/workflow-engine.css`, add CSS custom properties `--kind-trigger`, `--kind-action`, `--kind-system`, `--kind-timer`, `--error-red` with values that (a) avoid green and red for kind colors, (b) are distinct from each other, (c) have sufficient contrast in both light and dark themes (reuse existing `@media (prefers-color-scheme: dark)` pattern)
- [x] 4.2 Add `.kind-trigger`, `.kind-action`, `.kind-system`, `.kind-timer` classes mapping `fill` to the corresponding CSS custom property
- [x] 4.3 Add `.bar-error` (red stroke + stroke-width), `.orphan` (hatched fill via SVG `<pattern>` defined in each rendered fragment or via CSS `repeating-linear-gradient` if feasible in SVG fill)
- [x] 4.4 Add `.marker-set`, `.marker-clear-bg`, `.marker-x`, `.marker-auto` classes for instant markers
- [x] 4.5 Add `.timer-connector` class (stroke = kind-timer color, stroke-dasharray for dotted effect, fill none)
- [x] 4.6 Add `.flame-container` (max-height: 40vh, overflow-y: auto) and `.flame-empty` (muted text styling matching the existing empty-state rendering)
- [x] 4.7 Add `.tid-hit` (teal drop-shadow filter, no layout shift) and `.tid-dim` (opacity: .22) classes used by the cross-highlight JS
- [x] 4.8 Add `.bar-label` and `.bar-label-dim` classes for inline name + sub-caption duration text inside bars

## 5. Static JS — flamegraph.js

- [x] 5.1 Create `packages/runtime/src/ui/static/flamegraph.js` registering delegated listeners on `document` at DOMContentLoaded so they work without rebinding after HTMX fragment swaps
- [x] 5.2 Implement timer-id cross-highlight: on `mouseover` within any rendered SVG, walk up to find the nearest element with `data-timer-id`; add `.tid-hit` to all elements within the same SVG carrying that id and `.tid-dim` to all other non-text elements within the same SVG; clear classes on `mouseout`
- [x] 5.3 Implement bar/marker click handler: on `click` within any rendered SVG, resolve the clicked element's `data-event-pair` or `data-event-seq`; look up the corresponding `InvocationEvent` object(s) from a data payload the SSR layer embedded (decide: inline `<script type="application/json">` is forbidden by CSP; use a `<template>` tag with escaped JSON, OR re-issue a small lookup request, OR embed event references as individual `data-event-*` attributes carrying the JSON inline). Design decision: embed event JSON via `data-event-json` attributes on the bar/marker, or pre-load the full event list as a hidden `<template>` element whose `textContent` is JSON (template's `textContent` is not executed, is CSP-safe)
- [x] 5.4 Hook bar click → open the result-dialog (see section 6) with the resolved request and response events (or the single-record event)
- [x] 5.5 Include `flamegraph.js` in the dashboard shell's static script loads via the existing static-assets pattern (already `script-src 'self'`)

## 6. Result-dialog refactor for event display

- [x] 6.1 In `packages/runtime/src/ui/static/trigger-forms.js`, extract the dialog creation/showing functions (`getResultDialog`, `showResult`) into a shared module or ensure they're exportable and reusable from `flamegraph.js`
- [x] 6.2 Extend the dialog to support a "two-block" layout: a labelled "Request" `<pre>` block with its own copy button, followed by a labelled "Response" `<pre>` block with its own copy button; single-record events render with one block labelled by kind
- [x] 6.3 Preserve the existing trigger-ui call site's behavior (one block) via a shape discriminator passed to the open function
- [x] 6.4 Tests: dialog is opened with a (request, response) pair → two `<pre>` blocks rendered with correct JSON; dialog is opened with a single event → one `<pre>` block; both copy buttons work

## 7. Integration and invariants

- [x] 7.1 Add flamegraph DOM-structure scenarios to `packages/runtime/src/ui/html-invariants.test.ts` covering: rendered fragment contains no `style="`, `<style`, `<script`, `on*=`, or `:style="`; SVG contains expected `kind-*` classes; timer elements carry `data-timer-id`; paired bars carry `data-event-pair`
- [x] 7.2 End-to-end integration test: seed the EventStore with a fixture invocation; GET `/dashboard/invocations/<id>/flamegraph`; assert response is 200, body contains `<svg>`, expected bar and marker classes, and matching `data-timer-id` attributes across related elements
- [x] 7.3 End-to-end integration test for empty-state: GET an unknown id → 200 + `<div class="flame-empty">`; GET a pending id → same
- [x] 7.4 End-to-end integration test for list-view row expansion: GET `/dashboard/invocations` → succeeded rows contain `<details>` with correct HTMX attributes; pending rows do not

## 8. Validation

- [x] 8.1 Run `pnpm lint` and fix any biome findings
- [x] 8.2 Run `pnpm check` and resolve any TypeScript errors
- [x] 8.3 Run `pnpm test` (full suite, excluding WPT) and fix any regressions
- [x] 8.4 Run `pnpm exec openspec validate invocation-flamegraph --strict` to verify spec deltas parse cleanly
- [x] 8.5 Manually test the expanded flamegraph in a browser via `pnpm local:up` or equivalent: verify hover-highlight, click-opens-dialog, copy buttons, and that `<details>` expand/collapse is smooth; confirm no CSP violations in the browser console
