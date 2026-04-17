## Context

The dashboard list view currently surfaces `workflow · trigger · status · startedAt · duration` per invocation but nothing about what happened _inside_ an invocation. Meanwhile three recent changes — `fdae578` (stream paired invocation events from sandbox to bus), `0690037` (instrument timer globals with `timer.*` event kinds), `11e7b37` (instrument WASI clock/random/fd_write), and `91ce2be` (split `InvocationEvent` timestamp into wall-clock `at` + monotonic-µs `ts`) — landed a complete per-event trace of every invocation in the DuckDB `events` table, keyed by `(id, seq)`, with monotonic µs precision.

The raw material for a per-invocation timing breakdown therefore already exists server-side. The only work left is turning `InvocationEvent[]` into a pixel-ish layout the operator can scan.

This change adds that visualization as an in-place expansion on each invocation row. No sandbox surface, manifest format, or consumer pipeline touches. The fragment endpoint sits behind the same oauth2-proxy forward-auth that guards the rest of `/dashboard/*`.

## Goals / Non-Goals

**Goals:**
- Let an operator expand any completed or failed invocation row and see every captured event as a bar or marker on a shared µs timeline.
- Preserve parent/child relationships visually (depth-based rows for the main tree, separate track for timer callbacks whose `ref` is `null`).
- Make `timerId` correlations obvious at a glance via connector paths + on-hover cross-highlighting.
- Reuse existing UI primitives (`trigger-result-dialog`, `<details>` collapse, HTMX fragment swap) rather than introducing new modal or state machinery.
- Ship entirely server-rendered: the expanded fragment is valid without any layout JS running.

**Non-Goals:**
- Zoom, pan, or horizontal scroll beyond the card width. Fixed fit-to-card rendering; zoom is a clean follow-up via viewBox.
- Live-streaming or auto-refreshing in-flight invocations (pending rows are not expandable in v1).
- Filters, search, per-kind hide/show toggles. The list-view spec's v1 exclusion of filters stays in force.
- Additional bridge instrumentation (`setTimeout` + `setInterval` already land via `timer.*`; `console.*` and `crypto.*` remain un-emitted).
- Replay, retry, or any write-side interaction. Flamegraph is read-only.

## Decisions

### 1. Render strategy: server-rendered SVG with percent-unit attributes

Each bar is a `<rect x="N%" y="PX" width="M%" height="PX">` computed by the handler. `height` and `y` are in pixels (fixed row height, e.g. 18 px); `x` and `width` are percentages of invocation total duration.

Alternatives considered:
- **`<div>` bars with CSS-var positioning.** Requires a `/static/flamegraph.js` to set `style.setProperty('--left', pct)` on every bar after swap. Works under CSP but adds runtime layout JS and a MutationObserver for HTMX swaps.
- **Canvas.** Overkill for ~100–2 000 bars, loses DOM inspectability, blocks accessibility.
- **SVG with stretched viewBox (`preserveAspectRatio="none"`).** Gets responsive for free but stretches text labels. Would force HTML label overlays or `<foreignObject>`.

The percent-attribute approach gives responsive X (SVG width = 100% of the card), fixed-height rows, and text labels in SVG `<text>` at their natural font-size — no stretching and no layout JS for positioning.

### 2. Depth-based rows with overlap stacking

Row = distance from `trigger.request` via the `ref` chain. Events at the same depth that don't overlap in time share one row; events that _do_ overlap are pushed to a sub-row. Same algorithm applies within the timer track.

Rationale: matches classical flamegraph semantics and is robust to the sandbox's sync model (overlap is the degenerate case, not the common case). Kind color alone is used to distinguish purpose; row number says nothing about kind.

### 3. Timer callbacks get their own track

`timer.request` always has `ref: null` (system-initiated — the host event loop fired the callback, not user code). Putting it into the main tree would require inventing a synthetic parent edge. Instead, render the main tree on top (rooted at `trigger.request`), a visual divider, and a labeled `TIMER CALLBACKS` track below with one row per firing (overlap-stacked).

Connector `<path>` elements link each `timer.set` marker to every `timer.request` bar sharing its `timerId`. For `setInterval`, this means one origin fans out to N paths — an immediately legible signal of "this scheduled that."

Alternatives considered:
- **Pretend timer.request has ref=trigger.request.seq for layout.** Looks unified but lies about causality; confuses operators when a setInterval fires long after the scheduling action already returned.
- **Connector from set to clear as well.** Extra visual noise for low signal. `timerId` appears in both markers' tooltips already.

### 4. Single-record events render as row-height markers, not bars

`timer.set`, `timer.clear`, and `system.call` carry `input` + `output` in one record with no pair and no duration. Rendering them as 2px bars would confuse them with sub-µs paired events. Instead:
- `timer.set` = small solid teal rect (full row height), on the ref's row at event `ts`.
- `timer.clear` = small teal rect with a white `×` (two `<line>` elements) drawn inside. Auto-clear (`ref = null`) renders on row 0 at 55% opacity.
- `system.call` = small dot on the ref's row at event `ts`.

Each carries `data-timer-id="N"` on every SVG element so the highlight/dim delegated listener scoped to that SVG can treat them uniformly with their paired counterparts.

### 5. `system.call` always rendered, no toggle

WASI `clock_time_get` / `random_get` can fire dozens of times per invocation. We accept the clutter rather than introducing a filter toggle in v1 — filter UI is out of scope per the existing `dashboard-list-view` exclusion. If density becomes a real problem, a post-v1 follow-up can add per-kind visibility or aggregation.

### 6. Fragment endpoint semantics: always 200

`GET /dashboard/invocations/:id/flamegraph` returns `200` with either the flamegraph SVG or a one-line empty-state div. Three id states collapse to two responses:
- **Events exist for id** → SVG
- **No events** (unknown id, malformed id, or still-pending with no completed events yet) → `<div class="flame-empty">No flamegraph available for this invocation.</div>`

Rationale: HTMX by default doesn't swap response bodies on non-2xx status codes. Returning `200` for empty state avoids either a `hx-swap-error` declaration on every `<details>` or a global `htmx.config.responseHandling` override. Losing the HTTP-level distinction between "missing" and "empty" is acceptable — the UI cares only about the rendered fragment, and the route is behind operator auth so there's no external consumer.

No id-format validation. Malformed ids fall through the same DuckDB-parameterized query path and return zero rows, hence the empty-state fragment. Kysely parameterizes bindings so SQL injection is not a concern.

### 7. Expansion via native `<details>` + HTMX one-shot lazy-load

Each invocation row is a `<details><summary>…</summary><div class="flame-slot">…</div></details>`. The `<details>` element carries:

```
hx-get="/dashboard/invocations/<id>/flamegraph"
hx-trigger="toggle once"
hx-target="find .flame-slot"
hx-swap="innerHTML"
```

`toggle once` fires on the first open and never again — subsequent open/close cycles just show/hide the already-loaded fragment via native `<details>` behavior. No JS state machine, no expand coordinator.

Multiple rows can stay expanded simultaneously — no accordion coordination.

### 8. Reuse `trigger-result-dialog` for click-pinned details

Clicking a bar or marker opens the existing `<dialog>` currently used by `trigger-forms.js` to display trigger invocation results. The dialog is modified minimally to support rendering two stacked JSON blocks (request + response events) instead of one, each with its own copy-to-clipboard button. Single-record events open the dialog with one block.

Alternatives considered:
- **Inline detail panel below the flamegraph.** Requires always-present chrome (placeholder text when nothing clicked), adds a third vertical region after the main tree and timer track. Modal reuses a well-known primitive and avoids the fourth region.
- **Side drawer.** Extra layout work, worse vertical rhythm, unused today.

### 9. Timer-id cross-highlight via delegated listener

Every timer-related SVG element (`timer.set` marker rect, `timer.clear` marker rect + `×` lines, `timer.*` bars, connector paths) carries `data-timer-id="N"`. A single delegated listener attached per-SVG at load toggles `.tid-hit` and `.tid-dim` classes on `mouseover`/`mouseout`. Scoped per-SVG so hovering in one expanded invocation doesn't bleed across to another simultaneously expanded one.

The listener lives in `/static/flamegraph.js`. It registers against `document` on DOMContentLoaded and uses `event.target.closest('[data-timer-id]')` so it works for elements swapped in later by HTMX fragment loads without needing MutationObserver plumbing.

### 10. Event-store spec sync (bundled)

The current `openspec/specs/event-store/spec.md` describes a per-invocation lifecycle row model that no longer matches the live code: the `events` table keyed by `(id, seq)` has been in place since `fdae578`. The flamegraph change relies on that shape. Updating the spec to match reality is therefore both load-bearing for this change and a straightforward backfill of something already shipped.

Bundling avoids documenting a lie about the data source the flamegraph depends on.

## Sequence: row expansion end-to-end

```
operator        browser                 server/middleware              eventStore
-----------     -------                 ----------------------         -------------
click <summary>
                <details> toggles open
                HTMX fires:
                GET /dashboard/invocations/evt_abc/flamegraph
                            ────────────▶
                                         dashboardMiddleware routes to
                                         flamegraph handler
                                         handler calls:
                                                   ────────────────▶   query.where(id="evt_abc")
                                                                        .orderBy(seq).execute()
                                                   ◀────────────────   InvocationEvent[]
                                         render(events) → SVG string
                            ◀────────────
                HTMX swap into .flame-slot
                flamegraph.js delegated
                listener already bound
                (no rebind needed)
```

```
operator                        browser
-----------                     -------
hover a timer bar
                                delegated mouseover handler
                                  closest('[data-timer-id]')
                                  → tid=7
                                svg.querySelectorAll('[...]')
                                  .forEach(el => el.tid-hit /
                                                 el.tid-dim)
                                (filter effect + opacity)
mouse out
                                remove .tid-hit / .tid-dim
click a bar
                                delegated click handler
                                  closest('[data-event-pair]')
                                  → {requestSeq, responseSeq}
                                trigger-result-dialog.show(
                                  requestEvent, responseEvent
                                )
```

## Risks / Trade-offs

**[Risk] Very long invocations with thousands of events blow up DOM size.**  
Today the EventStore table has primary key `(id, seq)` — listing events for one id is O(k) where k = events for that invocation. Most invocations produce <100 events. Pathological invocations (5 000+ events) would render a 5 000-rect SVG. Mitigation: acceptable at current scale; a post-v1 capped-rendering follow-up can add "showing first 2 000 events, truncated by seq" if this becomes a problem.

**[Risk] `system.call` floods can visually saturate the flamegraph.**  
A `setInterval` firing `Date.now()` in a tight loop emits a `system.call` per call. The flamegraph shows every one as a dot. Mitigation: accepted in v1. If this lands as unreadable on real workloads, a kind-visibility toggle is the obvious v2 addition — spec-level space for that already exists (the v1 exclusion lists "filters"; unhiding is a filter-adjacent feature).

**[Risk] The stale `event-store` spec sync ships in the same PR as a feature.**  
Bundling documentation drift with a feature change blurs the "why this PR" framing. Mitigation: the proposal calls it out as an explicit second capability modification and the design doc flags it as load-bearing. Alternative is a prerequisite PR that only syncs the spec — rejected because it slows the feature with no behavior change to land.

**[Risk] CSP regression from a careless future edit.**  
The project's invariants forbid inline `style=` attributes and inline `<script>`. This change adds an SVG renderer; any future contributor could accidentally introduce `style=` on a bar while "fixing" a layout issue. Mitigation: the renderer outputs only class names and SVG attributes (`x`, `width`, `fill`, etc.); `html-invariants.test.ts` gains a scenario asserting the rendered fragment contains no `style=` attributes.

**[Risk] Operator confusion when the list says an invocation exists but the fragment returns empty state.**  
Possible if an archive file is purged between list load and fragment click. Mitigation: the empty-state copy ("No flamegraph available for this invocation") is neutral about cause; operators can refresh the list to re-query.

## Migration Plan

None required. Change is purely additive from a runtime-behavior perspective — the flamegraph is new DOM rendered at expand time. No existing archive files, event records, or on-disk formats change. Rolling back the PR removes the expand-to-flamegraph behavior and the spec deltas; the list-view otherwise continues to function identically.

## Open Questions

- Should the `timer.set` marker tooltip surface `input.delay` (e.g. "setTimeout · delay 100 µs")? Current lean: yes; cheap to include and saves a click when debugging "why did this fire late." Not load-bearing — can land with or without it, or follow up.
- Long-term: do we need horizontal zoom for the long-tail of 10 s+ invocations with sub-µs sub-calls? Not required now; SVG-based zoom-via-viewBox is a clean v2 follow-up without spec churn.
