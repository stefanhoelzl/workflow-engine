## Why

The trigger and dashboard UIs have accumulated small visual and behavioural rough edges that add up to real friction: triggers are listed flat even when a workflow has many, invocation cards and flamegraphs don't telegraph what's expandable or what's still loading, event markers are hard to spot, status signals compete with identity for the eye, and the CSS has drifted into ad-hoc font sizes, radii, spacings, and hardcoded hex values that break dark-mode parity (most visibly the sign-out button). The existing `trigger-ui` spec also describes an HTMX-banner submission flow that no longer matches the code — stale language from before the dialog-based flow landed. Fixing these together lets us re-baseline both the visual system (tokens, focus rings, theme parity) and the few spec-visible behaviours that changed along the way, rather than accreting more drift.

## What Changes

- **Trigger page**
  - Group triggers by workflow under per-workflow section headings; drop the redundant `workflow /` prefix from each card label; right-align the meta line (webhook URL / cron schedule) in monospace muted text.
  - When a trigger's input schema has no `properties` and no `additionalProperties`, omit the form entirely and render only the Submit button.
  - While a manual fire is in flight, disable Submit and show an inline spinner + "Submitting…" label; clear when the dialog opens.
  - Dialog reflects outcome via three visual states keyed on HTTP status class: success (2xx), client error (4xx), server/network error (5xx or fetch rejection). The dialog has a status banner naming the outcome and HTTP status.
  - Add a copy button on the HTTP trigger meta line (webhook URL).
- **Dashboard**
  - Cron invocations render an alarm-clock icon (today they fall back to a bullet).
  - Flamegraph event markers get higher-contrast fills, a 1px white stroke, and an SVG `<title>` tooltip naming the event kind.
  - When a flamegraph bar is errored, shift the duration label so the `⚠` icon no longer overlaps it.
  - Widen kind colour distinguishability by moving `--kind-action` to a distinct hue from `--kind-trigger`.
  - Expandable invocation cards get a right-aligned chevron that rotates on open and a subtle summary hover.
  - Timestamps render in the user's local timezone via a small client-side script that rewrites SSR'd `<time datetime=ISO>` elements.
  - Dashboard list grows a subheader with invocation count and "newest first".
  - Separate invocation-card identity (workflow / trigger) from status (badge moves to the metrics row).
  - Flamegraph summary restructured as a compact multi-part header (identity + status chip; metrics + nonzero counts) with a colour-and-marker legend above the ruler.
  - Orphan flamegraph bars gain a trailing `⇥` glyph + `<title>` "No terminal event recorded".
- **Accessibility pass**
  - Add `aria-busy` on the invocation list during skeleton load; live-region "Copied" confirmations on copy buttons; `role="group"` on topbar user controls; `aria-label` on expandable invocation summaries.
- **Visual token system**
  - Introduce type-scale tokens (`--fs-xs/sm/base/md/lg` + `--fs-micro`), spacing scale tokens (`--sp-1..7`), radii tokens (`--radius-sm/--radius/--radius-pill`), a focus-ring token applied via global `:focus-visible`, and an on-accent / overlay / shadow colour layer.
  - Replace hardcoded hex/rgba values with tokens; delete dead fallbacks (e.g. `var(--accent-primary, #0969da)` where `--accent-primary` doesn't exist).
  - Fix the skeleton shimmer to work in both light and dark mode via `color-mix` text-tint.
  - Unify icon language — one inline-SVG paradigm for nav, chevrons, and details markers (keeping the `<select>` caret data-URI as the only background-image exception).
- **Dark/light theme parity**
  - Tokenise every surface and control so both modes render consistently; specifically fix the sign-out button, auth-card brand icon, code chips, and overlay backgrounds. Add an audit gate (grep for raw hex/rgba outside `:root` + dark-mode blocks) and a manual smoke-test checklist covering both modes and all three trigger-dialog states.
- **Spec hygiene**
  - Rewrite the stale `trigger-ui` requirements that still reference the retired HTMX-banner flow (`EventSource.create`, `PayloadValidationError`, "HTML fragment containing a success banner") to describe the real dialog-based flow.

No breaking changes. No state wipe. No bundle-format change. No tenant re-upload.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `trigger-ui`: Add "triggers grouped by workflow" requirement; amend lazy-form initialization to permit omitting the form when the schema has no user-settable fields; replace the stale HTMX-banner submission flow with the current dialog-based flow that surfaces a three-state outcome keyed on HTTP status class.
- `dashboard-list-view`: Widen the flamegraph summary requirement from "single-line text summary" to a compact header region that permits a multi-part layout; extend the orphan-bar treatment to include a terminal-absence visual marker.

## Impact

- **Code**
  - `packages/runtime/src/ui/trigger/page.ts` — grouping, card-label, meta, empty-form rendering.
  - `packages/runtime/src/ui/dashboard/page.ts` — subheader, card identity/status split, chevron, local-time `<time>` emission, shared-icon import.
  - `packages/runtime/src/ui/dashboard/flamegraph.ts` — marker tooltips, warn/duration fix, two-part header, legend, orphan glyph.
  - `packages/runtime/src/ui/static/workflow-engine.css` — token system, focus ring, shimmer fix, theme parity, marker/warn visuals.
  - `packages/runtime/src/ui/static/trigger.css` — grouping sections, empty-form state, spinner, three-state dialog classes, copy button.
  - `packages/runtime/src/ui/static/trigger-forms.js` — loading state, dialog three-state call.
  - `packages/runtime/src/ui/static/result-dialog.js` — three-state classing, status banner, copy-confirm live region.
  - `packages/runtime/src/ui/static/flamegraph.js` — unchanged (DOM hooks already sufficient).
  - `packages/runtime/src/ui/layout.ts` — topbar `role="group"`, sign-out button token-driven styling.
  - **New**: `packages/runtime/src/ui/triggers.ts` — shared `triggerKindIcon`, `triggerKindLabel`, `triggerCardMeta` used by both trigger page and dashboard.
  - **New**: `packages/runtime/src/ui/static/local-time.js` — client-side `<time>` rewrite to browser locale.
- **Tests**
  - Existing tests that assert flat `<details>` lists on the trigger page or a single-line flamegraph summary will need updating in lockstep.
- **Dependencies**: none.
- **Security**: no sandbox / webhook / auth surface touched. No new globals. No CSP changes.
- **State**: none — no pending/archive wipe, no tenant re-upload, no bundle format change.
