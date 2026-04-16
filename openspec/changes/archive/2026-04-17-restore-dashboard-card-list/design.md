## Context

The dashboard's current `/dashboard` handler queries the EventStore synchronously and returns a full HTML page containing an `<table class="invocations-table">` plus status spans. That shape was a deliberate simplification during the CSP-hardening refactor (`8ae35d3 refactor(ui): prepare dashboard + trigger for strict CSP`) — inline `<style>` / `on*=` / Alpine string-literal bindings were removed and the renderer was flattened. The result works, but it lost the visual scan pattern of the previous design (state-colored rows, cards, async loading shape) and — more importantly — it doesn't leave a seam for the next dashboard features on the roadmap.

Upcoming phases (not in this change):

1. Phase 2 — inline flamegraph expand on card click (parent/child reconstruction from `seq` + `ref` event fields).
2. Phase 3 — filter bar (state, trigger type, event types).
3. Phase 4 — live updates.

Each of those targets the same fragment endpoint (filters vary its query params, expand swaps per-card content, live updates prepend rows). Establishing the shell + fragment shape now means phases 2–4 can ship as additive edits rather than restructurings.

The existing `workflow-engine.css` already carries a latent card palette (`.entry`, `.state-dot.*`, `.badge.*`) left over from the old dashboard — but under the `.done` class name, which diverges from the `"succeeded"` status string the middleware emits today. The rename is part of this change.

Security/CSP constraints (`SECURITY.md §6` + `CLAUDE.md` invariants) forbid inline `<script>`, `on*=` attributes, `style=` attributes, string-form Alpine `:style` bindings, and free-form `x-data` literals. The `html-invariants.test.ts` suite enforces this on every HTML renderer and must keep passing.

## Goals / Non-Goals

**Goals:**

- Restore the card-list visual language, driven by a page shell + async-loaded fragment.
- Give each rendered invocation a stable DOM identity keyed by invocation id, so phase 2 can target cards without a full re-render.
- Keep the renderer CSP-clean — no new inline script/style/event-handler surfaces.
- Leave the existing EventStore query shape untouched.

**Non-Goals:**

- Filters (no query params on the fragment in this change).
- Inline expand / flamegraph rendering / detail routes.
- Polling, SSE, or any live-update transport.
- Click handlers. Cards have no wired interaction in phase 1 (the DOM seam is prepared; behavior is phase 2's concern).
- Pagination beyond the existing "last N" limit.
- Performance tuning of the EventStore query.

## Decisions

### D1 — Shell + fragment split, HTMX-driven

`GET /dashboard` returns the full HTML shell (topbar, sidebar, page header, an empty `#invocation-list` container with an `hx-get="/dashboard/invocations"` + `hx-trigger="load"` + skeleton placeholders inside it for the pre-swap state). `GET /dashboard/invocations` returns the list-body HTML fragment (a sequence of `.entry` cards — or an `.empty-state` div — with no `<html>`/`<body>` wrapper). HTMX is already loaded by `layout.ts` (`<script src="/static/htmx.js">`); no new dependency.

Alternatives considered:

- *SSR the list on `/dashboard` like today.* Rejected: doesn't leave the fragment seam phase 2 needs, and the loading-state UX improvement (no layout jump) disappears.
- *Side-render via Alpine + `fetch()`.* Rejected: Alpine `x-data` object literals are banned by `CLAUDE.md` CSP policy, and we'd be recreating HTMX's swap semantics in ~30 lines of Alpine.
- *Server-Sent Events from day one.* Rejected: solves a future problem (live updates). Phase 1 has no live data to push.

### D2 — Renderer split into shell + list

`renderDashboardPage(user, email)` returns the shell (no invocation data). `renderInvocationList(invocations: readonly InvocationRow[])` returns the fragment body. Both live in `packages/runtime/src/ui/dashboard/page.ts`. The middleware's two routes call these two renderers respectively. `html-invariants.test.ts` is updated to call both.

Alternatives considered:

- *Single renderer with a `mode: "shell" | "fragment"` flag.* Rejected: two distinct outputs with different call-sites; a single function with a mode flag obscures the contract.

### D3 — Fragment URL: `GET /dashboard/invocations`

Chosen over the previous design's `GET /dashboard/list?fragment=...` pattern because:

- Resource-oriented name (`/invocations`) reads cleanly and survives future evolution.
- The previous design used `?fragment=stats|triggerTypes|eventTypes|list` to multiplex multiple fragments through one route. Phase-1 only has one fragment, so the multiplex adds nothing. When phase 3 adds filter-aware responses, they're query params on the same resource, not separate fragment identifiers.
- Nests cleanly with phase 2's expected per-invocation routes (e.g. `/dashboard/invocations/{id}/flamegraph`).

The route sits inside the existing Hono sub-app mounted at `/dashboard/*`, so `githubAuthMiddleware` + oauth2-proxy forward-auth continue to cover it with no additional wiring.

### D4 — Card markup and stable DOM identity

Each card:

```html
<div class="entry" id="inv-{{id}}" aria-expanded="false">
  <div class="entry-header">
    <span class="state-dot {{status}}" aria-hidden="true"></span>
    <span class="entry-workflow">{{workflow}}</span>
    <span class="entry-trigger">{{trigger}}</span>
    <span class="badge {{status}}">{{status}}</span>
  </div>
  <div class="entry-meta">
    <span class="entry-started">{{startedAt ISO}}</span>
    <span class="entry-sep">·</span>
    <span class="entry-duration">{{duration | "—"}}</span>
  </div>
</div>
```

`id="inv-{id}"` is the stable DOM identity phase 2 will target (e.g. `hx-target="#inv-{id}"` on the expand handler). `aria-expanded="false"` is pre-set so the attribute already exists in the DOM when phase 2 flips it — and it also advertises future expandability to assistive tech, even while phase 1 has no wired handler.

No click handler, no `cursor: pointer`, no chevron in phase 1. Phase 2 adds those in one edit without needing to restructure the card.

### D5 — Status vocabulary and CSS class rename

The middleware emits the status string `"succeeded"` (not `"done"`). The existing `.badge.done` / `.state-dot.done` rules in `workflow-engine.css` predate that decision. We rename the CSS classes to `.succeeded` rather than translate at render — single source of truth, no runtime class-name mapping. Nothing else in the codebase references `.badge.done` or `.state-dot.done` (the current dashboard uses `.status-succeeded` on a `<span>`, which is removed by this change).

Alternatives considered:

- *Translate `succeeded → done` in the renderer.* Rejected: creates a silent mismatch between the data string and the class attribute.
- *Add `.succeeded` alongside `.done`.* Rejected: leaves dead CSS.

### D6 — Loading state: three skeleton cards with shimmer

The shell's `#invocation-list` contains three `<div class="entry skeleton">` placeholders before HTMX swaps. Shimmer via a `@keyframes` on a pseudo-element; a `@media (prefers-reduced-motion: reduce)` guard disables the animation (placeholders stay visible, just static). Three cards approximates the list density and avoids post-swap layout jump for small result sets; when the fragment arrives, the whole container contents are replaced (`hx-swap="innerHTML"`).

### D7 — Empty state is the fragment's responsibility

When the EventStore returns zero trigger-request rows, the fragment body is `<div class="empty-state">No invocations yet</div>`. The shell does not pre-render an empty state — one HTML path, owned by the fragment renderer. `hx-swap="innerHTML"` replaces the skeleton placeholders with the empty-state div in that case.

### D8 — No query params on the fragment (yet)

The fragment route ignores its query string in phase 1. Phase 3 adds `state=`, `type=`, `eventTypes=` semantics. Adding parameter parsing now would be dead code, and the current EventStore query (two fixed `.where()` calls in the middleware) doesn't need filtering yet. The fragment URL shape reserves room for filters without committing to their semantics.

### D9 — Dead CSS cleanup

Removing `.invocations-table`, `.invocation-row`, `.invocation-workflow`, `.invocation-trigger`, `.invocation-status`, `.invocation-started`, `.invocation-duration`, `.status-succeeded`, `.status-failed`, `.status-pending` from `workflow-engine.css`. They're exclusively referenced by the current dashboard page and become unreachable after this change. Biome's unused-CSS lint doesn't run against stylesheets, so this is a manual check — justified by a project-wide grep during implementation.

## Sequence

```
  Browser                  Hono                     EventStore
     │                      │                           │
     │   GET /dashboard     │                           │
     │─────────────────────▶│                           │
     │   200 HTML (shell +  │                           │
     │   3 .entry.skeleton) │                           │
     │◀─────────────────────│                           │
     │                      │                           │
     │   [HTMX load trigger fires]                      │
     │   GET /dashboard/    │                           │
     │        invocations   │                           │
     │─────────────────────▶│                           │
     │                      │   query: trigger.request  │
     │                      │──────────────────────────▶│
     │                      │◀──────────────────────────│
     │                      │   query: trigger.         │
     │                      │        response/.error    │
     │                      │──────────────────────────▶│
     │                      │◀──────────────────────────│
     │   200 HTML fragment  │                           │
     │   (.entry cards or   │                           │
     │   .empty-state)      │                           │
     │◀─────────────────────│                           │
     │                      │                           │
     │ [HTMX swaps into #invocation-list]               │
```

## Risks / Trade-offs

- **[Risk] Users see skeleton then content — momentary two-frame render.** → Mitigation: three skeleton cards sized to match real cards, so layout doesn't jump. HTMX swap is synchronous on receipt; on a local fetch this is imperceptible.
- **[Risk] HTMX fragment failure leaves the user staring at skeletons forever.** → Mitigation: deferred. Phase 1 does not add an error state. If the EventStore query throws, Hono returns 500 and HTMX leaves the skeleton in place. Acceptable for a local/auth'd dashboard and explicitly flagged as follow-up work (candidate for phase 3 when we touch this code again).
- **[Risk] CSS class rename `.done → .succeeded` affects other consumers.** → Mitigation: grep the repo during implementation. Current audit shows only the dashboard references these classes; the trigger UI uses its own palette.
- **[Risk] `aria-expanded="false"` on a non-interactive card confuses screen readers in phase 1.** → Mitigation: this is a deliberate forward-contract for phase 2. A screen reader encountering `aria-expanded="false"` on a non-button element is benign (the attribute is technically advisory). Phase 2 adds `role="button"` + `tabindex="0"` when the interaction is wired.
- **[Trade-off] The shell renders before auth-bearing queries run.** → Acceptable: the shell is data-free, so no authorization decision depends on it. The fragment route applies the same middleware. Worst case: a user lacking permission sees the shell then gets a 401/403 HTMX response (behaviour unchanged from pre-this-change in principle — `/dashboard` was already behind forward-auth).
- **[Trade-off] HTMX is now load-bearing for the dashboard, not just the trigger UI.** → Acceptable: HTMX is already loaded by the shared layout. This just makes its swap semantics a runtime dependency of the dashboard rather than a dev-time affordance.
