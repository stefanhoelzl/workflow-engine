## Why

Three problems converge:

1. **The UI looks dated and is inconsistent across surfaces.** Login, dashboard, trigger, and error pages each render the topbar and brand differently. Light/dark parity is partial. Trigger-kind glyphs are emoji that render visibly differently on macOS / Windows / Linux — fine for a casual app, weak for a developer tool.

2. **The UI specs are partitioned by code module, not by outcome, and have absorbed implementation detail.** `shared-layout` documents a `<Layout>` JSX component shape, a "MUST be synchronous, not Promise-typed" rule, and an enumerated list of script tags. `static-assets` mixes HTTP-serving with 404-page DOM structure and references the JSX components by name. `dashboard-list-view` (~600 lines) and `trigger-ui` (~500 lines) lock specific class names (`.entry`, `.entry-expand-chevron--placeholder`), framework attributes (`hx-get`, `hx-trigger`), and library names (Jedison). The recent JSX migration is a textbook example of the cost: it forced amendments to three specs because they bound implementation, even though no externally visible behaviour changed. This violates OpenSpec's stated principle ("a spec is a behaviour contract, not an implementation plan; if implementation can change without changing externally visible behaviour, it likely does not belong in the spec") and creates churn whenever the UI implementation is touched.

3. **Visual identity is unspec'd.** Tokens, theme detection, motion, focus rings, and asset-delivery rules have no canonical home. CSP no-inline / Alpine.data invariants live in CLAUDE.md but not in OpenSpec, so their cross-cutting nature is invisible from the spec landscape.

This change repartitions the UI specs around outcomes, introduces a single cross-cutting `ui-foundation` capability for visual contracts that cross every surface, extracts a universal topbar so brand and user identity render consistently, and ships a developer-focused visual identity (compact density, mono for technical strings, neutral surfaces, single accent green with strict allowlist).

## What Changes

### Spec landscape

- **NEW spec `ui-foundation`** captures cross-surface visual contracts:
  - Theme detection via `prefers-color-scheme` (light/dark; no manual toggle, no localStorage override).
  - `prefers-reduced-motion` disables animation; only meaning-carrying status indicators (e.g. the `running` pulse) are exempt.
  - CSP-clean: no inline styles, no inline scripts, no `on*=` event-handler attributes, no `style=` attribute, no `javascript:` URLs, no inline Alpine `x-data` literals.
  - Keyboard focus is always visible.
  - **Universal topbar** present on every UI surface (authenticated, login, error pages). Always renders the brand wordmark "Workflow Engine" coloured with the active accent token. User identity (username + email + sign-out) renders iff the request resolved a session — no defensive fallback for error pages; if session resolution fails, the topbar simply renders without user info.
  - Asset delivery: `/static/*` serves UI assets with content-type whitelist, immutable cache, and same-origin-only references from rendered pages.
  - Cross-surface kind colour mapping by event prefix (`trigger`, `action`, `system`) — same palette used by the dashboard list, event log, sidebar tree, and flamegraph slices.
  - Cross-surface status semantics (`pending` / `running` / `succeeded` / `failed`, plus optional `exhaustion` dimension pill).
  - Icon rendering invariants: inline SVG with strokes inheriting `currentColor`; no external icon-font dependencies, bitmap sprites, or platform emoji rendering for any user-meaningful indicator.
  - Each top-level event prefix has a distinct visual indicator used consistently across every surface.
  - Each trigger kind has a distinct visual indicator used consistently wherever the kind is surfaced.

- **NEW spec `ui-errors`** captures 404 and 5xx page outcomes (universal topbar, anonymous-friendly when no session, descriptive heading + message + dashboard link, CSP-clean rendering).

- **REFOCUSED `shared-layout`**: drops function signatures (`renderLayout`, `<Layout>` shape), Promise-typed-props rule, file-imports, internal class names, the CSS-variable list, and the universal-script-set requirement. Keeps outcome contracts: every authenticated UI surface presents (1) a universal topbar (delegated to `ui-foundation`), (2) a sidebar with the owner→repo→trigger tree (expansion derived from URL), (3) a content area for the page body.

- **REFOCUSED `dashboard-list-view`**: drops class names, htmx attribute names, function references, expandable-mechanism specifics (`<details>` / `<div>` choice), per-row DOM structure. Keeps outcome contracts: list contents, sort order, URL filtering, expand-to-flamegraph behaviour, flamegraph slice colour mapping (delegated to `ui-foundation`), status / dispatch / exhaustion / synthetic row indicators.

- **REFOCUSED `trigger-ui`**: drops library names (Jedison), htmx attribute names, internal class names. Keeps outcome contracts: trigger list scope, schema-driven form generation, fire-result feedback dialog.

- **DELETED `static-assets`**: contents redistribute to `ui-foundation` (asset delivery contract) and `ui-errors` (404/5xx outcomes); build-time discovery (`import.meta.glob`) and JSX-component references (`<NotFoundPage/>`, `<ErrorPage/>`) cease to be specified — they are implementation.

- **DELTA `auth`** (login-page-route requirement): updates the login page to render the universal topbar from `ui-foundation` rather than its own embedded brand markup.

### Visual implementation

- New design tokens in `packages/runtime/src/ui/static/workflow-engine.css`:
  - Surfaces: neutral zinc family (no blue tint).
  - Accent: bright green `#22c55e` (dark) / `#16a34a` (light); used per the green allowlist.
  - Text-accent (technical emphasis): sky blue `#7dd3fc` / `#0369a1`.
  - Status colours: `succeeded` green / `failed` red / `running` amber, plus exhaustion-dimension pill.
  - Kind palette by event prefix: `trigger=blue`, `action=purple`, `system=amber`.
- Light/dark via `prefers-color-scheme` only.
- Density: 13px base, 32px row height, 40px topbar.
- Motion: 80ms / 160ms ease-out, disabled under `prefers-reduced-motion` (only `running` status pulse exempt).
- **Universal topbar.** A new `<TopBar/>` JSX component (in `icons.tsx` or a new `topbar.tsx` — code-organisation choice) is rendered by `<Layout/>`, the login page, and `<ErrorShell/>`. Takes optional `user` / `email` props; renders the user section iff both are present. The login page gains a topbar (currently has none); error pages flip from "always anonymous" to "best-effort: user identity when session resolved".
- **Wordmark.** `<TopBar/>` renders "Workflow Engine" as text styled in `--accent` (font-weight 600, slight negative letter-spacing). The existing `BrandIcon` SVG and the standalone "W" letter glyph in `error-pages.tsx` and `auth/login-page.tsx` are removed. `BrandIcon` is deleted from `icons.tsx`.
- **Lucide kind icons.** `TriggerKindIcon` in `icons.tsx` is rewritten from emoji glyphs (🌐 ⏰ 👤 📨) to inline Lucide-style SVG (clock for cron, globe for http, mouse-pointer-click for manual, mail for imap). Identical rendering across platforms.
- **Row-gutter event-prefix icons.** Dashboard rows and event log lines gain a leftmost icon column with a Lucide-style SVG per event prefix (zap for trigger, box for action, terminal for system). Icon carries the colour; text stays neutral.
- **Component visual recipes** (button variants, list-row anatomy, status indicator, kind icon, form input, modal) documented in `docs/ui-guidelines.md` — not in spec.

## Capabilities

### New Capabilities

- **`ui-foundation`** — cross-surface visual contracts (theme detection, motion respect, CSP invariants, focus visibility, universal topbar, asset delivery, cross-surface colour & status mappings, icon rendering invariants).
- **`ui-errors`** — 404 and 5xx page outcomes.

### Modified Capabilities

- **`shared-layout`** — outcome-only refocus; removes function signatures, JSX-component shape, internal class names, CSS-variable list, universal-script-set requirement.
- **`dashboard-list-view`** — outcome-only refocus; removes class names, htmx attribute names, expand-mechanism specifics, function references.
- **`trigger-ui`** — outcome-only refocus; removes library names, htmx attribute names, internal class names.
- **`auth`** — login page renders the universal topbar from `ui-foundation`; brand element clarified as wordmark.

### Removed Capabilities

- **`static-assets`** — all contents redistributed; spec ceases to exist after archival.

## Impact

- **Workflow authors:** no rebuild / re-upload required. UI is host-side; no SDK or sandbox change.
- **Out-of-tree consumers:** CSS class names (`.entry`, `.badge`, `.brand-mark`, `.topbar-brand`) remain present in the implementation — they're just no longer locked by spec. Anything grepping for them continues to work; anything depending on them being stable should bind to spec'd outcomes (HTML structure landmarks, ARIA roles, semantic token vocabulary).
- **Operators:** no operational impact.
- **Documentation:** `docs/ui-guidelines.md` is a new file; CLAUDE.md gains a single cross-link to it under "Code Conventions" plus a brief reminder that PRs touching `workflow-engine.css` should keep `docs/ui-guidelines.md` in sync.
- **Tests:** `html-invariants.test.ts` continues to enforce CSP-cleanliness invariants. The `ui-foundation` spec's "no inline" requirement is captured via `#### Scenario` blocks describing observable conditions; the test name is not referenced in spec (consistent with house convention).
- **Cross-references in CLAUDE.md / SECURITY.md:** existing references to `shared-layout` / `dashboard-list-view` paths remain valid (no renames). Two security invariants gain spec backing: "no inline styles/scripts" and "asset same-origin only" are now traceable to `ui-foundation` requirements alongside their existing `http-security` / CSP backing.
