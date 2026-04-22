## Context

The runtime ships two internal UIs: `/trigger` (manually fire a workflow trigger via a JSON-Schema form) and `/dashboard` (list recent invocations, expand to view an inline SVG flamegraph). Both are SSR'd via Hono + hono/html, theme-driven by CSS custom properties, behaviour-driven by small `/static/*.js` modules operating under a strict CSP (no inline styles, no inline scripts, no `on*` handlers).

Two things have drifted:

1. **Visual system drift.** Eight discrete font sizes (9/10/11/12/13/14/16 px + `0.9em`), five radii (3/4/8/10/20 px), thirteen unique padding values, and numerous hardcoded hex/rgba literals scattered outside the `:root` + `@media (prefers-color-scheme: dark)` blocks. Some literals hide real bugs — e.g. `var(--accent-primary, #0969da)` on the auth-card brand icon falls through the fallback because `--accent-primary` doesn't exist, so the "accent" renders as hardcoded GitHub blue regardless of theme. The sign-out button is pinned to GitHub-black (`#24292f`/`#32383f`) and reads as a light-mode button pasted onto the dark topbar.
2. **Behavioural drift against spec.** The `trigger-ui` spec still describes an HTMX-banner flow (`source.create`, `PayloadValidationError`, "HTML fragment containing a success banner") that the code no longer implements — current reality is a JSON fetch to `/webhooks/...` or `/trigger/...` rendering a `<dialog>` client-side. The `dashboard-list-view` spec mandates a "single-line text summary" above the flamegraph, which this change deliberately breaks to increase legibility.

We're bundling both streams because the behavioural items need the token system underneath them (e.g. three-state dialog colors want a `--warn` token to sit alongside `--accent`/`--error`), and the theme-parity audit only closes cleanly once every surface is token-driven.

## Goals / Non-Goals

**Goals:**
- Collapse the visual system to a small set of named tokens (type scale, spacing, radii, colour roles, focus ring) so adding a new component is a composition exercise, not a copy-a-magic-number exercise.
- Make dark and light mode render consistently on every surface — no "pasted from the other theme" moments, and a mechanical audit gate against future drift.
- Resolve the `trigger-ui` spec drift in one shot by rewriting the requirements that describe the retired HTMX-banner flow.
- Improve scannability on both pages: group triggers by workflow; give invocation cards a clear expand affordance; make flamegraph markers, status, and timestamps unambiguous at a glance.
- Keep CSP posture intact (no inline style/script/handler introduced).
- Keep security posture intact (no sandbox/webhook/auth surface touched, no new globals).
- Keep state posture intact (no pending/archive/storage wipe, no tenant re-upload, no bundle format change).

**Non-Goals:**
- A third "warn" dialog state beyond the 2xx/4xx/5xx split (explicitly out of scope).
- Richer marker tooltips (timer id, offset, payload) — the `<title>` element carries the event name only.
- Invocation-event correlation from the manual-fire dialog — the synchronous HTTP response already mirrors the outcome.
- A cron-expression humanising library.
- An in-app theme toggle (OS `prefers-color-scheme` remains the only switch).
- Sorting trigger groups by last-invocation-ts or surfacing error dots on failing triggers (cross-concern with event store; separate change).
- Moving `renderTriggerCard` itself into the new shared `triggers.ts` module — only the small reusable helpers go in.

## Decisions

### D1 — One change, not two

**Decision:** Bundle the visual-token refactor, the behavioural UI refinements, the a11y pass, the theme-parity audit, and the stale-spec rewrite into a single change.

**Alternatives considered:** (a) A narrow proposal covering only the five spec-visible items, with the ~28 spec-invisible items implemented as an ordinary branch; (b) three sequential proposals (tokens → behaviours → parity).

**Rationale:** The five spec-visible items all depend on tokens that don't exist yet — splitting would mean either writing the spec delta against a transient shape or delaying the spec work until after the tokens land. The theme-parity audit is only meaningful once the tokens exist. A single proposal captures the coupled intent without fragmenting the spec surface.

### D2 — Tokens first, then behaviour, then parity audit

**Decision:** Tasks execute in three phases in order: (1) establish the token system and retrofit the CSS to use it; (2) implement the behavioural/visual changes; (3) run the theme-parity audit and manual smoke test over the final state.

**Alternatives considered:** Behaviour-first (users see UX wins sooner); interleaved (token introduction as each component is touched).

**Rationale:** Tokens-first means every subsequent edit lands on a coherent foundation — no mid-refactor rules that will be re-edited a third time. The parity audit at the end gates the whole change on consistency: cheap to run (grep + manual walk), expensive to skip (drift re-accumulates). Users see the visible UX wins one phase later than behaviour-first, but the PR-scale risk is far lower.

### D3 — Three-state dialog keyed on HTTP status class

**Decision:** The trigger-fire result dialog distinguishes three visual states:
- `2xx` → success (green border + "✓ Success — <status>" banner)
- `4xx` → client error (amber border + "⚠ Failed — <status> <body.error ?? ''>" banner)
- `5xx` or network/fetch rejection → server error (red border + "✗ Error — <status> <body.error ?? ''>" banner)

State selection happens in `showResultBlocks(response, body)` in `/static/result-dialog.js` via a pure switch on `response.status` (and a sentinel for fetch rejection). Classes: `.trigger-result-dialog--success`, `--warn`, `--error`; all three are removed before any one is added.

**Alternatives considered:** Two-state (green/red on `r.ok`); body-shape inspection (distinguish `{error, issues}` vs `{error, details}`); a richer three-state that peeks at `body.error` to further split 4xx.

**Rationale:** Both `/webhooks/*` and `/trigger/*` already produce 4xx for user-correctable validation errors and 5xx for infra failures — the status-class contract is kind-agnostic and future-proof (a new trigger backend gets the three-state treatment for free as long as it honours the invariant). Body-shape inspection couples the dialog to response-envelope details and breaks whenever a handler returns something novel. The spec deliberately does not name the colours — they're a presentation choice that may evolve.

### D4 — Flamegraph header: widen the spec, don't narrow it

**Decision:** Amend the `dashboard-list-view` "Summary line and ruler" requirement to drop the word "single-line" and require only that all named fields (workflow, trigger, duration, action count, system count, status) be present in a "compact header region" above the ruler. The actual rendered layout becomes two stacked lines (identity + right-aligned status chip on line 1; prominent duration + nonzero-count tokens on line 2 + colour/marker legend below), but the spec stays layout-agnostic.

**Alternatives considered:** Prescriptive "two-line" requirement (locks in the specific shape); keep "single-line" and visually wrap via CSS (brittle under long workflow/trigger names).

**Rationale:** The original "single-line" was overreach — it described an implementation, not a contract. Widening lets us iterate on layout without spec churn.

### D5 — Shared `triggers.ts` scope

**Decision:** The new `packages/runtime/src/ui/triggers.ts` exports three helpers:
- `triggerKindIcon(kind: string): HtmlEscapedString` — hono `<span class="trigger-kind-icon">…</span>`
- `triggerKindLabel(kind: string): string` — `"HTTP"`, `"Cron"`, fallback `kind`
- `triggerCardMeta(descriptor: TriggerDescriptor): string` — `"POST /webhooks/<tenant>/<workflow>/<name>"` or `"<schedule> (<tz>)"`

Both `ui/trigger/page.ts` and `ui/dashboard/page.ts` import from it. `renderTriggerCard` itself does not move.

**Rationale:** The helpers capture the drift class (icon + label + meta are currently duplicated and can silently diverge when a kind is added). `renderTriggerCard` is trigger-page-specific and moving it would bloat the shared module with trigger-page concerns. Adding a new kind touches one file for the shared bits.

### D6 — Local-timezone timestamps via post-SSR rewrite

**Decision:** SSR emits `<time datetime="<ISO>">` elements (ISO string as both the `datetime` attribute and the initial text content). A new `/static/local-time.js`, loaded on `DOMContentLoaded`, queries `time[datetime]` and replaces `textContent` with `new Date(ISO).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'medium'})`. If JS is disabled, the ISO fallback remains legible.

**Alternatives considered:** Server-side Accept-Language parsing (unreliable, no timezone info); inline `<script>` (forbidden by CSP); dispatch via Alpine.js x-init (breaks the no-inline-attribute CSP stance we maintain).

**Rationale:** Standalone external script matches the existing `/static/*.js` pattern; CSP-clean; degrades gracefully. Browser's `toLocaleString` handles locale+timezone without adding a date library.

### D7 — Shimmer gradient via `color-mix`

**Decision:** Replace the skeleton shimmer's `linear-gradient(transparent, var(--bg-surface), transparent)` band with `linear-gradient(90deg, transparent 0, color-mix(in srgb, var(--text) 6%, transparent) 50%, transparent 100%)`.

**Rationale:** The current gradient fails in both modes — in light mode `--bg-surface` is *darker* than `--bg-elevated`, so the shimmer reads as a moving shadow; in dark mode the two differ by ~3% luminance, so it's invisible. A text-tint wash is always lighter-on-elevated regardless of mode. `color-mix` is in all evergreen browsers we target.

### D8 — Global `:focus-visible` via `:where(...)`

**Decision:** Single global rule:
```css
:where(a, button, select, input, textarea, summary, [role="button"]):focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}
:focus:not(:focus-visible) { outline: none; }
```
`--focus-ring: 0 0 0 2px var(--bg-elevated), 0 0 0 4px var(--accent);` (two-layer: inner surface ring + outer accent ring).

**Rationale:** `:where(...)` keeps specificity at 0, so component-level overrides still win. Two-layer shadow works against any card background. `:focus:not(:focus-visible)` suppresses the mouse-click focus artefact without disabling keyboard rings.

### D9 — Audit gate: grep, not lint rule

**Decision:** The theme-parity audit is a task-level check (grep the CSS for remaining `#[0-9a-f]{3,6}` / `rgba?\(` outside `:root` + `@media (prefers-color-scheme: dark)`) plus a manual smoke-test checklist. Not a CI rule.

**Alternatives considered:** Stylelint rule enforcing token usage; pre-commit hook.

**Rationale:** A stylelint rule costs setup + maintenance; the audit is a one-time closing gate on this change. Future drift is cheap to re-detect with the same grep when next touching CSS. If drift becomes a recurring class, a lint rule is a follow-up change.

### D10 — Stale `trigger-ui` spec: rewrite in-place, not deprecate

**Decision:** The spec delta replaces the affected requirements outright (MODIFIED) rather than marking old ones REMOVED + adding new. The retired HTMX-banner flow has no tenants depending on it, no client code targeting it, and no test asserting it as live behaviour.

**Rationale:** OpenSpec MODIFIED + REMOVED is for genuine capability deprecation. These requirements describe prior implementation state, not a separate capability. Clean rewrite keeps the spec readable.

## Risks / Trade-offs

- **Risk: Tokenisation sweep accidentally changes a computed value and someone notices a colour "off by a shade".**
  → Mitigation: The token values are chosen to match the current computed results unless the current value is explicitly wrong (e.g. sign-out button, auth brand icon, shimmer). The parity audit catches any unintentional visual diff via the manual smoke test covering both OS themes.

- **Risk: Test snapshots / HTML-shape assertions break on the trigger grouping, flamegraph header restructure, or `<time>` element swap.**
  → Mitigation: Each affected test is an explicit task; failures surface early. No asymmetric rollout — tests and implementation land together.

- **Risk: `color-mix(in srgb, …)` fails on older Safari / Firefox.**
  → Mitigation: Baseline `color-mix` support lands in Safari 16.4 (March 2023) and Firefox 113 (May 2023). Users on older browsers see the current (broken) shimmer. Acceptable.

- **Risk: Changing `--kind-action` colour breaks someone's mental model / existing screenshot documentation.**
  → Mitigation: The doc we care about (SECURITY.md, CLAUDE.md, specs) doesn't reference specific bar colours. External screenshots are a non-concern for this internal UI.

- **Risk: The three-state dialog introduces a new `.trigger-result-dialog--warn` class that future handlers ignore (e.g. a handler returns 418 and the dialog shows amber, not what the author wanted).**
  → Mitigation: The spec contract is explicit on status-class semantics (4xx = client error, 5xx = server error). Handlers that need custom signalling can choose their status code deliberately.

- **Trade-off: One bundled change vs. multiple small ones.**
  → Picked bundle. Coupling of tokens ↔ theme-parity ↔ three-state dialog is the reason; the matching saved feedback for this project is "for refactors in this area, bundled PR over many small ones".

- **Trade-off: Widening the flamegraph-header spec means we can't enforce a single-line layout later.**
  → Acceptable — "single-line" was incidental, not intentional.

## Migration Plan

No runtime migration. No tenant re-upload. No state wipe. No bundle rebuild required from tenants.

**Deployment:**
1. Merge to `main`; CI builds + pushes `ghcr.io/<repo>:main`.
2. Staging deploy runs automatically via `deploy-staging.yml`.
3. Manual smoke-test checklist (part of the audit task) executed on staging in both OS theme modes.
4. Cherry-pick onto `release` → approved prod deploy via `deploy-prod.yml`.

**Rollback:** `git revert` on `release`, push; production redeploys the previous image. No data to migrate back.

## Open Questions

1. **Proposal name** — `refresh-trigger-and-dashboard-ui` is descriptive but long. Keep as-is unless a shorter name surfaces.
2. **Do any existing tests depend on the flat `<details>` structure of the trigger page?** — Discovered during task execution; the grouping task includes updating any such tests.
3. **Does the stale `trigger-ui` spec have any residual test coverage referencing `EventSource.create` / `PayloadValidationError`?** — Checked during the spec-rewrite task.
4. **Are there any hardcoded literals in `infrastructure/` Helm values or generated OAuth pages that also reference the GitHub-black button colour?** — Out of scope for this change; flagged for a follow-up if found.

## Full plan summary (for reference during task execution)

The 33-item breakdown kept from the pre-proposal planning session:

**Shared module** (new): `src/ui/triggers.ts` — three helpers per D5.

**Trigger page (7 items):**
1. Group by workflow (`<section><h2>…</h2>…</section>`; alpha-sorted groups + triggers). **Spec delta.**
2. Drop workflow from card label.
3. Meta line right-aligned, monospace, muted.
4. Hide form when schema has no `properties`/`additionalProperties`. **Spec delta.**
5. Submit loading: disable + `.submit-btn--loading` spinner + "Submitting…".
6. Dialog outcome: three states per D3. **Spec delta.**
7. Copy button on HTTP trigger meta (reuses `.trigger-result-copy` styles).

**Dashboard (12 items):**
8. Cron icon via shared module.
9. Marker visibility: saturated fill + 1px white stroke.
10. Marker `<title>` tooltips (event name only).
11. Warn/duration overlap fix (shift duration left by icon width when errored).
12. `--kind-action` → teal `#14b8a6`.
13. Expandable card chevron + hover bg.
14. Local-timezone timestamps per D6.
15. Dashboard list subheader (`N invocations · newest first · updated HH:MM:SS`).
16. Card identity vs status separation (status badge moves to metrics row).
17. Flamegraph two-line header. **Spec delta.**
18. Flamegraph legend (four colour swatches + two marker examples).
19. Orphan bar `⇥` glyph + `<title>`. **Spec delta.**

**Accessibility pass (4 items):**
20. `aria-busy` on `#invocation-list` during skeletons.
21. `role="status" aria-live="polite"` copy-confirmations.
22. Topbar `role="group" aria-label="Signed in as …"`.
23. `aria-label="Expand invocation details"` on expandable summaries.

**Visual polish / tokens (7 items):**
24. Type scale: `--fs-xs/sm/base/md/lg` + `--fs-micro`.
25. Spacing scale: `--sp-1..7`.
26. Tokenise colours (`--on-accent`, `--overlay-strong`, `--overlay-weak`, `--shadow-modal`).
27. Unify radii: `--radius-sm/--radius/--radius-pill`.
28. Global `:focus-visible` per D8.
29. Skeleton shimmer per D7.
30. Unify icon set (one inline-SVG paradigm).

**Dark/light theme parity (3 items):**
31. Every surface token-driven (sign-out button, auth brand icon, literals, code chips).
32. Audit gate: grep for stray hex/rgba outside `:root` + dark-mode blocks per D9.
33. Manual smoke-test checklist (both modes; /dashboard, /trigger, auth, dialog all three states, flamegraph).
