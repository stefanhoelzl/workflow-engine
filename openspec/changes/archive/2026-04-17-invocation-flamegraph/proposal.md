## Why

The dashboard list tells operators an invocation took N ms but offers no way to see _why_. Every `trigger.*`, `action.*`, `system.*`, `timer.*`, and `system.call` event already lands in the EventStore with monotonic µs timestamps — the data for a timing breakdown is already captured, only the visualization is missing. Adding a flamegraph closes the "what took so long / what was called when" debug loop entirely server-side, with no sandbox or instrumentation changes.

## What Changes

- Invocation rows in `/dashboard/invocations` become expandable via native `<details>`/`<summary>`. Expanding fires a one-shot HTMX GET that lazily loads the flamegraph fragment for that invocation.
- New fragment endpoint `GET /dashboard/invocations/:id/flamegraph` returns an SSR'd SVG with the invocation's event tree rendered as a flamegraph. Reads events from `eventStore.query.where(id=?).orderBy(seq)` — no new EventStore method required.
- Flamegraph rendering rules:
  - Bars for paired kinds (`trigger.*`, `action.*`, `system.*`, `timer.*`) positioned by `ts` on a shared µs axis; width = `response.ts − request.ts`.
  - Depth-based row assignment in a main tree (rooted at `trigger.request`) plus a separate timer-callbacks track for `timer.request` roots (since `timer.request.ref === null`).
  - Single-record kinds render as instant markers at their `ts` on the ref-parent's row: `timer.set` = solid teal tick, `timer.clear` = teal tick with white ×, `system.call` = dot. Auto-clear (`ref=null`) renders on row 0 at reduced opacity.
  - Dashed teal connector paths link each `timer.set` marker to every `timer.request` bar sharing its `timerId` (setInterval fan-out supported).
  - Kind colors: trigger=blue, action=indigo, system=amber, timer=teal. Failed bars carry a red border + ⚠ icon, kind fill preserved. Orphan request bars (no matching response, e.g. engine-crashed) extend to `trigger.error.ts` with a hatched pattern.
- Interactions:
  - Hover any bar or marker → small tooltip with name + `X µs @ +Y µs`.
  - Hover any timer-related element → all elements sharing its `data-timer-id` (set/clear markers, fire bars, connectors) highlight; other elements dim.
  - Click any bar or marker → reuses the existing `trigger-result-dialog` to show the request event and response event (or a single-record event) as two raw-JSON blocks with copy-to-clipboard.
- Endpoint returns `200` with a one-line "No flamegraph available for this invocation" fragment for unknown or pending ids. No 4xx for missing ids; HTMX swaps the body unconditionally.
- Completed and failed invocations are expandable; pending invocations are not (matches v1 scope).
- **MODIFY** `dashboard-list-view`: remove "flame graph rendering" from the v1 exclusion list; add requirements for row expansion, the fragment endpoint contract, rendering rules, and interactions.
- **MODIFY** `event-store`: sync the stale spec with the live code. The events table stores one row per `InvocationEvent` keyed by `(id, seq)`, not one row per invocation-lifecycle record.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-list-view`: removes flame-graph-rendering exclusion; adds expandable-row behavior, fragment endpoint contract, flamegraph layout and styling rules, and hover/click interaction contracts (DOM presence level).
- `event-store`: spec now describes the per-`InvocationEvent` row model (primary key `(id, seq)`) that the live `event-store.ts` already implements, replacing the outdated per-invocation lifecycle row description.

## Impact

**Affected code**:
- `packages/runtime/src/ui/dashboard/` — middleware gains a new route; new `flamegraph.ts` renderer module that turns an `InvocationEvent[]` into the SSR'd SVG fragment.
- `packages/runtime/src/ui/static/` — new `flamegraph.js` for the timer-id cross-highlight and bar/marker click → dialog wiring; CSS additions in `workflow-engine.css` for kind colors, marker glyphs, connectors, hatched pattern, tid-hit/tid-dim classes.
- `packages/runtime/src/ui/static/trigger-forms.js` — minor refactor so the existing result-dialog component accepts the "two JSON blocks side-by-side" layout needed for request+response pairs (or one block for single-record events).
- `packages/runtime/src/ui/html-invariants.test.ts` — extended with flamegraph DOM-structure scenarios.

**No changes to**:
- The sandbox boundary. Every event kind the flamegraph relies on is already emitted.
- Manifest format, action SDK, or workflow authoring surface.
- External dependencies (no new packages).
- The EventBus consumer pipeline.

**Security**:
- Route is under `/dashboard/` — already covered by the oauth2-proxy forward-auth at Traefik per SECURITY.md §4. No new auth surface.
- SVG is server-rendered with escaped text content; no user-supplied input reaches the DOM unescaped.
- CSP unaffected: new JS lives in `/static/flamegraph.js` loaded via `script-src 'self'`; all styling goes through the existing `workflow-engine.css`; no inline `style=` attrs, no inline `<script>`, no `on*=` handlers.
- No `Authorization` headers, session cookies, or secrets logged by the new handler.
