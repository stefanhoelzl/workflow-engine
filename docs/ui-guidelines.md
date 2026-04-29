# UI Guidelines

Style guide for the runtime's authenticated and anonymous UI surfaces. Companion to the `ui-foundation`, `ui-errors`, `shared-layout`, `dashboard-list-view`, and `trigger-ui` OpenSpec capabilities — those describe what the UI **must do** (behaviour contract); this doc describes what it **looks like** (style implementation).

The CSS implementation lives in `packages/runtime/src/ui/static/workflow-engine.css` and `trigger.css`. The JSX components live under `packages/runtime/src/ui/`. PRs that change the values below should keep this doc in sync.

CSP-cleanliness, theme detection, motion respect, and the universal topbar are behaviour contracts in `ui-foundation` — they are NOT documented here as recommendations; they are enforced. This doc only covers the values + recipes that sit on top of those contracts.

## Token system

Tokens are CSS custom properties on `:root`. Light theme is the default; dark theme overrides via `@media (prefers-color-scheme: dark)`. Both blocks live in `workflow-engine.css`.

### Surfaces (neutral zinc, no blue tint)

| Token              | Light       | Dark      | Use                                                  |
| ------------------ | ----------- | --------- | ---------------------------------------------------- |
| `--bg`             | `#fafafa`   | `#131316` | Page background                                      |
| `--bg-surface`     | `#f4f4f5`   | `#18181b` | Recessed sections (sidebar, list headers)            |
| `--bg-elevated`    | `#ffffff`   | `#1d1d20` | Cards, modals, anything visually "raised"            |
| `--bg-hover`       | `#ededee`   | `#232327` | Hover background for rows + cards                    |
| `--border`         | `#e4e4e7`   | `#2a2a2e` | Default 1px border colour                            |
| `--border-strong`  | `#d4d4d8`   | `#3f3f46` | Stronger border (hover/focus borders, dividers)      |

### Text

| Token                | Light       | Dark      | Use                                                |
| -------------------- | ----------- | --------- | -------------------------------------------------- |
| `--text`             | `#18181b`   | `#e8e8ea` | Body text, headings                                |
| `--text-secondary`   | `#52525b`   | `#a1a1aa` | Less emphasised body text                          |
| `--text-muted`       | `#71717a`   | `#71717a` | Captions, disabled, placeholders                   |
| `--text-accent`      | `#0369a1`   | `#7dd3fc` | Technical-emphasis text (event-kind names, ts)     |

### Accent (brand green) — strict allowlist

| Token              | Light       | Dark      |
| ------------------ | ----------- | --------- |
| `--accent`         | `#16a34a`   | `#22c55e` |
| `--accent-strong`  | `#15803d`   | `#16a34a` |
| `--accent-bg`      | `rgba(22,163,74,0.10)` | `rgba(34,197,94,0.14)` |

`--accent` is the brand green. It SHALL appear only in:

- Topbar wordmark (universal topbar, `.topbar-brand` text colour)
- Primary CTA buttons (`.btn--primary`, `.error-link`, `.submit-btn`) via `--btn-bg`
- Focus ring (`--focus-ring`'s outer layer)
- Sidebar-active text (`.sidebar-section.active`, `.sidebar-owner-link.active`, etc.)
- Success status indicator (`.badge.succeeded` border/foreground via `--green` which is the same hex as `--accent` in light mode)

Reviewers SHOULD reject PRs that introduce `--accent` outside the allowlist without a strong justification. Adding a new allowlist slot is fine; using `--accent` everywhere defeats the green-as-signal contract.

### Status palette

| Token         | Light       | Dark        | Use                                  |
| ------------- | ----------- | ----------- | ------------------------------------ |
| `--green`     | `#16a34a`   | `#22c55e`   | Success status, "ok" indicators      |
| `--green-bg`  | `#f0fdf4`   | `rgba(34,197,94,0.14)` | Tinted bg for success badges |
| `--red`       | `#dc2626`   | `#f87171`   | Failure / error                      |
| `--red-bg`    | `#fef2f2`   | `rgba(248,113,113,0.14)` | Tinted bg for error      |
| `--yellow`    | `#d97706`   | `#fbbf24`   | Pending / running / warn             |
| `--yellow-bg` | `#fffbeb`   | `rgba(251,191,36,0.14)` | Tinted bg for pending      |
| `--blue`      | `#2563eb`   | `#60a5fa`   | Info / dispatch chip                 |
| `--blue-bg`   | `#eff6ff`   | `rgba(96,165,250,0.14)` | Tinted bg for dispatch chip |

### Cross-surface kind palette

Per the `ui-foundation` "Cross-surface kind colour mapping" requirement: the dashboard invocation list, event log, sidebar tree, and flamegraph slices all derive kind colour from a single prefix-keyed palette.

| Token              | Light       | Dark      | Maps to                          |
| ------------------ | ----------- | --------- | -------------------------------- |
| `--kind-trigger`   | `#2563eb`   | `#60a5fa` | `trigger.*` events; http/imap kinds |
| `--kind-action`    | `#9333ea`   | `#c084fc` | `action.*` events; manual kind   |
| `--kind-rest`      | `#d97706`   | `#fbbf24` | `system.*` events; cron kind     |

### Trigger-kind icon colour assignment

Three semantic categories, three colours (`--kind-*` tokens shared with the event-prefix palette above):

| Kind       | Category | Token           | Rationale                              |
| ---------- | -------- | --------------- | -------------------------------------- |
| `cron`     | internal | `--kind-rest`   | Self-scheduled by the engine           |
| `http`     | external | `--kind-trigger`| Caller-driven (HTTP request inbound)   |
| `imap`     | external | `--kind-trigger`| Caller-driven (mail inbound)           |
| `manual`   | manual   | `--kind-action` | Human-initiated via /trigger UI        |

### Decorative tokens (implementation, not contractual)

These are present in CSS but not part of the design contract — change freely:

- `--shadow`, `--shadow-lg`, `--shadow-modal` — drop shadows
- `--radius-sm` (4px), `--radius` (8px), `--radius-pill` (999px) — corner radii
- `--sp-1` … `--sp-7` — spacing scale (4, 8, 12, 16, 24, 32, 48 px)
- `--fs-micro` … `--fs-lg` — font-size scale (10–16 px)

## Type and density

| Concern             | Value                                                         |
| ------------------- | ------------------------------------------------------------- |
| Sans (default)      | `-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", …`   |
| Mono                | `"JetBrains Mono", "SF Mono", "Cascadia Code", "Fira Code"`   |
| Base font size      | 13px (`--fs-base`)                                            |
| Topbar height       | 40px (`--topbar-height`)                                      |
| Row height (target) | 32px (entry rows, trigger rows)                               |

### Mono usage rule

Monospace SHALL be used only for technical strings:

- SHA digests (`workflowSha`, short-shas)
- Timestamps (`@<time>`, ISO timestamps, `at` event field)
- Identifiers (`evt_…`, owner/repo/workflow names where appropriate)
- Durations (`307ms`, `1.4s`)
- URLs and key=value pairs in event-message rendering
- Code fences and `<code>` blocks

Body text, button labels, headings, and the topbar wordmark stay in the sans stack.

## Motion

Two duration constants (CSS values, not tokens):

| Speed   | Duration | Use                                                            |
| ------- | -------- | -------------------------------------------------------------- |
| Fast    | 80ms     | Hover state changes (background transitions on rows / buttons) |
| Slow    | 160ms    | Enter/exit animations (modals, dropdowns, expanded details)    |

All motion respects `prefers-reduced-motion: reduce` per `ui-foundation`. The `running` status pulse is the documented carve-out — it carries meaning and remains animated under reduced-motion.

Easing: `ease-out` is the default; `ease` is acceptable for symmetric transitions.

## Iconography

All UI icons SHALL be rendered as inline SVG in `packages/runtime/src/ui/icons.tsx`. The set is Lucide-derived (24×24 viewBox, 1.6–2 px stroke, `currentColor`). No emoji glyphs, no external icon-font fetch, no bitmap sprites.

### Trigger-kind icon table

| Kind     | Lucide name              | Component        |
| -------- | ------------------------ | ---------------- |
| `cron`   | clock                    | `<CronIcon/>`    |
| `http`   | globe                    | `<HttpIcon/>`    |
| `manual` | user                     | `<ManualIcon/>`  |
| `imap`   | mail                     | `<ImapIcon/>`    |

Used by `<TriggerKindIcon kind={...}>` in the dashboard `.entry` rows, the trigger card summary, and the sidebar trigger leaves.

### Event-prefix icon table

| Prefix     | Lucide name | Component               |
| ---------- | ----------- | ----------------------- |
| `trigger`  | zap         | `<TriggerPrefixIcon/>`  |
| `action`   | box         | `<ActionPrefixIcon/>`   |
| `system`   | terminal    | `<SystemPrefixIcon/>`   |

Used by `<EventPrefixIcon prefix={...}>` for event log lines and any future cross-surface event-prefix surface (currently flamegraph slices use the `--kind-*` colour tokens directly via `kind-trigger`/`kind-action`/`kind-rest` classes).

## Component visual recipes

The component contracts (what the user sees, what URLs respond) live in the spec landscape; this section captures the visual treatment.

### Buttons

Single size, three variants:

- `.btn` — neutral. Default border + bg-surface; hover deepens border to `--text-secondary`.
- `.btn--primary` — green CTA. Background `--btn-bg` (resolves to `--accent`); hover `--btn-bg-hover` (resolves to `--accent-strong`).
- `.btn--secondary` — `.btn` with reduced opacity (0.85). Used as a less-prominent sibling to a primary CTA.

States: focus follows the global `--focus-ring` (two-layer: surface gap + accent outer); disabled reduces opacity and removes pointer cursor.

### Data list rows (dashboard `.entry`, trigger `.trigger-details`)

- White card on `--bg-elevated`, 1px `--border`, 8px radius.
- Compact padding: `var(--sp-2) var(--sp-3)` (8/12 px), min-height 32px.
- Hover: background fades to `--bg-hover` over 80ms — no shadow lift.
- Cards stack with 8px gap (`var(--sp-2)` margin-bottom).

### Status indicators

- `.badge.<status>` — pill with status-tinted background + foreground + border. Uppercase label, 11px font-size, `--radius-pill`.
- `.state-dot.<status>` — coloured dot with a wider tinted ring. The `pending` / `running` dot pulses (the documented motion carve-out).
- `.entry-dispatch` — info chip ( `--blue-bg` / `--blue` / `--blue-border`); appears between identity and status when `meta.dispatch.source === "manual"`.
- `.entry-exhaustion` — small label adjacent to `.badge.failed` carrying the dimension (`CPU` / `MEM` / `OUT` / `PEND`) when the failure was associated with a `system.exhaustion` event.

### Form inputs (trigger forms via Jedison)

- Input borders inherit `--border`; focus states inherit the global `--focus-ring`.
- Labels in `--text-secondary`; helper text in `--text-muted`.
- Error states (zod issue feedback) — `--red` border, `--red-bg` tint, error text below.
- The implementation follows the active theme via `--bg-*` / `--text-*` tokens; no hard-coded colours.

### Modal — result dialog

- Centered card, `--shadow-modal`, max-width 520px, padding `--sp-5`.
- Backdrop dim using `--overlay-strong` (semi-opaque black).
- Trapped focus while open; Esc closes.

### Universal topbar

40px tall, fixed top, `--bg-elevated` with a 1px bottom border. Contents:

- `.topbar-brand` — wordmark "Workflow Engine" in `--accent` (semibold, slight negative letter-spacing). No icon.
- `.topbar-user` — username + email + sign-out form. Renders iff `user` prop is supplied.

The topbar appears on every UI surface (authenticated, login, error pages). On login + anonymous error pages, only the wordmark renders. See `ui-foundation` for the full contract.

### Brand mark — wordmark only

Branding is text-only ("Workflow Engine") in `--accent`. There is no SVG logo; if a logo design becomes available, replace the text with an SVG that itself uses `currentColor` and place it inside `.topbar-brand`. No `.brand-mark` element.

### Auth card (login surface)

- Width: 380px max, 100% wide on small screens.
- Padding `--sp-5`, `--shadow` (NOT modal), `--bg-elevated`, 1px border.
- Content: optional banner (alert/status) + provider sections. Branding lives in the universal topbar above; the card itself has no embedded brand element.

### Error pages (404 / 5xx)

- Centered card on the main content area, below the universal topbar.
- Title in `--text` (16px, semibold), message in `--text-secondary`, link styled as `.btn--primary` (so it visually matches the dashboard's primary CTA).
- Both pages render the universal topbar; user identity appears when the request resolved a session.

## Migration phases (from `redesign-ui` proposal)

1. **Token swap** — CSS variables only, no surface changes. Visual diff is the colour shift.
2. **Brand & icon refresh** — `<TopBar/>` extraction, wordmark replacing brand SVG, Lucide kind/prefix icons.
3. **Per-surface CSS rewrites** — tighten densities, replace hover-shadow with hover-bg, narrow auth card, error link adopts btn--primary.
4. **Spec deltas** — `ui-foundation` + `ui-errors` created, `static-assets` removed, `shared-layout` / `dashboard-list-view` / `trigger-ui` / `auth` refocused.
5. **This doc** — token table, recipes, conventions.
6. **Validate** — `pnpm validate`, `html-invariants.test.ts`, dev probes.
7. **Archive** — `pnpm exec openspec archive redesign-ui`.

## Enforcement

- CSP cleanliness (no inline `<style>` / `<script>` / `on*=` / `javascript:`) is enforced by `packages/runtime/src/ui/html-invariants.test.ts`. The test asserts observable conditions on rendered output for every UI surface.
- `prefers-color-scheme` and `prefers-reduced-motion` are CSS-level; spot-check visually via DevTools simulation (Firefox: Inspector toolbar sun/moon icon for theme; Chromium: Rendering panel for reduced-motion).
- The green allowlist is convention enforced by code review. Tooling assistance (a grep-based linter that flags `var(--accent)` outside the allowlisted selectors) would be a future addition; today there is none.
