## Context

This proposal does two things in one cycle: it (1) repartitions the UI specs to follow OpenSpec's "behaviour contract, not implementation plan" principle, and (2) ships a developer-focused visual identity. The two are intertwined because the visual identity surfaces cross-cutting contracts (theme detection, motion respect, CSP cleanliness, asset delivery) that don't fit under any single existing per-surface spec — they need a home, and the cleanest home is a new `ui-foundation` capability.

## The partitioning principle

OpenSpec's `concepts.md` is unambiguous: a spec is a behaviour contract; implementation can change without changing externally visible behaviour, and when it can, it doesn't belong in the spec. Applied to UI, the test draws a clean line:

```
   THE TEST: if implementation changes, does externally visible
             behaviour change?
   ════════════════════════════════════════════════════════════════

   Claim                                   Test     Lives in
   ──────────────────────────────────────  ──────   ─────────
   Light/dark via prefers-color-scheme     YES      spec
   prefers-reduced-motion disables motion  YES      spec
   CSP-clean: no inline style/script       YES      spec
   Keyboard focus always visible           YES      spec
   Brand wordmark in brand position        YES      spec
   /static/* paths + cache + mime          YES      spec
   Cross-surface kind colour mapping       YES      spec
   Cross-surface status semantics          YES      spec
   ──────────────────────────────────────  ──────   ─────────
   --accent: #22c55e (exact hex)           NO       docs
   Type scale (12/13/14/16px steps)        NO       docs
   Density (32px row height)               NO       docs
   Motion durations (80ms / 160ms)         NO       docs
   Green allowlist enumeration             NO       docs
   Mono usage rule                         NO       docs
   Token names (--bg, --text, etc.)        NO       docs
   Per-component visual recipes            NO       docs
```

Things that "feel like spec" but fail the test (and therefore go to `docs/ui-guidelines.md`):

- Exact hex values. `#22c55e` vs `#21c45d` is not an externally visible behaviour change.
- Token names. CSS variables are an implementation API, not a user-observable contract.
- Pixel values for padding / radius / spacing scales. Same reasoning.
- Specific motion durations. The contract is "motion respects user preference"; whether the hover transition is 80ms or 100ms is design iteration.
- The green allowlist (where green appears). Adding a sixth allowed location is design coherence, not behavioural breakage.
- The mono usage rule (mono only for technical strings). Same reasoning.

The line stays principled by asking "what would I file a bug for?" If a user with `prefers-color-scheme: dark` saw light-mode UI, they'd file a bug — that's a contract breach. If `--accent` shifts a hue, no user files a bug; the maintainer might dislike it, which is design feedback.

## Why the per-surface specs need refocusing too

`shared-layout`, `dashboard-list-view`, and `trigger-ui` today mix outcome with implementation. Examples:

- `shared-layout` says "the system SHALL provide a `<Layout>` JSX component (in `packages/runtime/src/ui/layout.tsx`)" with explicit prop names, "MUST be synchronous, not Promise-typed" rules, and an enumerated script-tag list — TypeScript signatures and framework choices, not contracts.
- `dashboard-list-view` says rows are `<details>` elements with `hx-get="…/flamegraph"` — an HTMX implementation detail.
- `trigger-ui` says "Jedison styling" — names a specific JSON-editor library.

**The just-rebased `feat(ui): migrate HTML rendering to server JSX (hono/jsx)` commit is a textbook example of the cost.** That refactor swapped Hono's `html\`...\`` template strings for JSX components — a pure implementation change with zero externally visible behaviour change. Yet it forced amendments to `shared-layout`, `static-assets`, and `auth` specs because those specs bound the previous implementation (`renderLayout` function, `HtmlEscapedString` return types, the static `404.html` / `error.html` files). Worse, the same commit *added* new implementation detail to the specs (`<Layout>` prop names, "synchronous-only" rule, JSX-component references in 404/5xx requirements). Each refactor accumulates more spec churn. Under our refocused specs, this same migration would have touched zero spec files.

These references don't survive implementation refactors. If we replaced HTMX with a custom Alpine component tomorrow, the externally visible behaviour (rows expand to show a flamegraph) wouldn't change, but the spec would fail validation. That's the symptom of an over-bound spec.

The refocus is mechanical:
1. Read each requirement.
2. Ask the test: would changing the named symbol break user-visible behaviour?
3. If yes, keep. If no, rewrite to the outcome it's serving.

Net effect: `shared-layout` shrinks ~40%; `dashboard-list-view` shrinks ~50%; `trigger-ui` shrinks ~50%. Concrete behaviours (sort order, URL filtering, dispatch chip on `meta.dispatch.source === "manual"`, exhaustion pill on `system.exhaustion` event association) all stay; framework choices and class names go.

## Why `ui-foundation` is a new capability rather than a section in `shared-layout`

Tempting to fold the cross-cutting concerns into `shared-layout`, but they're orthogonal:

- `shared-layout` describes what every authenticated UI surface contains (top bar, sidebar, content area). It's a per-page-shell spec.
- `ui-foundation` describes invariants that hold across every UI surface including login (which has no shell) and 404/5xx (which use a different shape). It's a cross-cutting cross-surface spec.

`prefers-color-scheme` applies to login as much as to dashboard. So does `prefers-reduced-motion`, focus visibility, asset delivery, CSP, and — after this proposal — the universal topbar. Folding them into `shared-layout` would either (a) imply they only apply to authenticated surfaces (wrong), or (b) require a "see also" disclaimer on every other UI spec. A separate `ui-foundation` is the natural home.

## The universal topbar

A specific architectural choice this proposal locks in: every UI surface (authenticated, login, error pages) renders the **same** topbar component. The topbar always shows the brand wordmark; user identity (username + email + sign-out) renders iff the request resolved a session.

This solves a pre-existing inconsistency: today, `layout.tsx` renders one brand markup, `auth/login-page.tsx` renders another (a literal "W" character with separate text), and `error-pages.tsx` renders a third. After the JSX migration, this drift became visible in three different files producing three different brand renderings. A single `<TopBar/>` component used across all surfaces makes the inconsistency impossible by construction.

Two design choices behind this:

1. **No defensive fallback for error pages.** The just-rebased `static-assets` spec forces error pages to render anonymously regardless of session state, with the rationale that the global `onError` handler may fire when session middleware itself crashed. This proposal flips that: the error-page renderer reads `c.get("user")` like any other page; if the value is undefined (because session middleware never ran or threw), the topbar renders without user info — same as on the login page. No try-catch wrapper, no special anonymous-rendering branch. If something deeper breaks (e.g. context object itself throws), we want that surfaced as a real error, not papered over.

2. **TopBar is owned by `ui-foundation`, not `shared-layout`.** The topbar is cross-surface (it appears on login and error pages too), so the contract belongs in the cross-cutting spec. `shared-layout` keeps only the *additional* requirements that authenticated surfaces have (sidebar, content area).

## Why `ui-errors` is a new capability rather than left in `static-assets`

`static-assets` today owns three unrelated concerns: HTTP file serving, build-time file discovery (an implementation), and the structural content of the 404 / 5xx pages. The third is a UI surface outcome — what does a user see when they hit a 404? — and naturally belongs alongside `shared-layout` and `dashboard-list-view` as a peer per-surface spec.

Once `ui-errors` owns the 404/5xx outcomes and `ui-foundation` owns the asset-delivery contract (the only meaningful HTTP-serving claim — paths, MIME, cache), `static-assets` has nothing left. Build-time discovery is implementation. The spec ceases to exist.

This is OpenSpec's "if implementation can change without changing externally visible behaviour, it doesn't belong in spec" rule applied at the spec-file level: a spec whose only remaining content is implementation should be deleted.

## Why we keep existing names

A nice-to-have would be renaming `shared-layout` → `ui-shell`, `dashboard-list-view` → `ui-dashboard`, `trigger-ui` → `ui-trigger` for symmetry with `ui-foundation` / `ui-errors`. We deliberately don't:

- Renames churn cross-references (CLAUDE.md, SECURITY.md, archived change descriptions, `openspec list` output).
- The naming asymmetry costs nothing at read time — anyone scanning `ls openspec/specs/` will see the UI cluster regardless of prefix.
- "Leave better than you found it" — name churn is decoupable from the partitioning win and can land separately if desired.

## The wordmark and Lucide-icon structural touch-ups

These are NOT pure-CSS changes; they touch HTML structure in `layout.ts`, `auth/login-page.ts`, and `triggers.ts`. We agreed to allow them as small surgical edits because:

1. **Cross-platform consistency.** Emoji glyphs (`\u{23F0}` clock, `\u{1F310}` globe) render visibly differently across macOS, Windows, and Linux. A developer tool's UI should look the same on every developer's machine. Lucide SVG renders identically.
2. **Brand coherence.** The brand-mark SVG today is a placeholder geometry ("a small rounded-square 'W'-ish glyph" per code comments). Replacing it with the wordmark in `--accent` is a one-step decision rather than a "design a logo" project deferred forever.
3. **Scope.** Each touch-up is a surgical edit (one function in `triggers.ts`; one block in `layout.ts`; one block in `login-page.ts`). No page restructure, no behavioural change.

These edits are described in the relevant spec deltas as outcomes ("the brand position renders the wordmark", "the trigger-kind icon is a platform-stable inline graphic"); the implementation lives in code.

## Alternative considered: docs-only

We considered shipping `docs/ui-guidelines.md` alone with no OpenSpec deltas. Rejected because:

- The visual contracts that ARE behavioural (theme detection, reduced-motion, CSP, focus visibility, asset delivery, cross-surface colour mapping) deserve OpenSpec's review/validate gate.
- The existing UI specs already over-bind implementation; leaving them as-is locks today's mistakes into the future.
- A docs-only style guide gives no scaffolding for agents that need to know "what every UI surface must do" — they'd have to read all four UI specs plus the doc.

## Alternative considered: full OpenSpec including hex values and component recipes

Rejected because hex values and per-component visual recipes fail OpenSpec's behaviour-contract test, and locking them under proposal flow imposes friction with no contract benefit. Big design systems (Primer, Material) document tokens in dedicated reference pages, not in behavioural specs — there's no industry precedent for treating exact hex values as a contract.

## Token system design

`docs/ui-guidelines.md` is the canonical home for token values. The CSS file (`workflow-engine.css`) is the implementation; the doc is the human-readable reference. They diverge over time only if PRs change the CSS without updating the doc — mitigated by mentioning the doc in CLAUDE.md and relying on PR review.

Token categories (all live in CSS; the doc enumerates load-bearing ones):

- **Semantic surfaces:** `--bg`, `--bg-surface`, `--bg-elevated`, `--bg-hover` — neutral zinc family.
- **Semantic text:** `--text`, `--text-secondary`, `--text-muted` — high-contrast on neutral surfaces.
- **Borders:** `--border`, `--border-strong` — hairline (1px) by convention.
- **Accent:** `--accent`, `--accent-strong`, `--accent-bg` — the brand green. `--text-accent` for technical emphasis (sky blue).
- **Status:** `--green`, `--green-bg`, `--red`, `--red-bg`, `--yellow`, `--yellow-bg`, `--grey`, `--grey-bg` — semantic status colours.
- **Kind:** `--kind-trigger`, `--kind-action`, `--kind-system` — by event prefix.
- **Decorative (CSS-only, not in doc):** shadows, radii, spacing scale, individual font-size steps — implementation.

## Cross-surface coordination rules

Two rules in `ui-foundation` are explicitly cross-surface:

1. **Kind colour mapping by event prefix.** The dashboard's invocation row, the events log, and the flamegraph's bar colours all derive from the same prefix→colour table. If they ever diverge, an operator scanning a flamegraph and a row simultaneously sees inconsistent visual cues — a real defect. The rule is spec'd as: "kind colours are derived from the leading event-prefix segment (`trigger`, `action`, `system`)" without binding the exact hex of each.

2. **Status semantics.** The dashboard row's status badge, the row-leading status icon, and any cross-surface filter UI all use the same vocabulary (`pending`, `running`, `succeeded`, `failed`, plus `exhaustion` dimension pill). Adding a new status is a cross-surface change.

These rules belong in `ui-foundation` because they're enforced across multiple per-surface specs.

## Migration phases

Phase ordering picks the safest landing first:

```
   PHASE 1  Token swap                CSS only, no surface changes
            New variables in workflow-engine.css; existing classes
            keep their names and structure; only the colour/density
            of the page changes.
            Risk: very low. Visual diff. No DOM changes.

   PHASE 2  Wordmark                  Small structural edit
            Drop .brand-mark SVG in layout.ts; render wordmark.
            Same on auth/login-page.ts.
            Risk: low. Two single-block edits. CSS handles styling.

   PHASE 3  Lucide kind icons         Small structural edit
            Replace emoji return value in triggers.ts triggerKindIcon
            with inline SVG. Add row-gutter icon to dashboard rows
            and events log lines.
            Risk: low. One function + two HTML insertion points.

   PHASE 4  Per-surface CSS rewrites  Iterative tightening
            Rewrite the existing component CSS to match the visual
            recipes in docs/ui-guidelines.md. Surface-by-surface:
            dashboard, trigger, login, errors.
            Risk: low. CSS only. Each surface independently testable.

   PHASE 5  Spec deltas               OpenSpec validate run
            Apply all spec deltas; run pnpm exec openspec validate.
            Risk: low. Pure spec edits.

   PHASE 6  docs/ui-guidelines.md     New file
            Token table, recipes, conventions, migration phases.
            Risk: none.

   PHASE 7  Validation                pnpm validate + dev probes
            pnpm lint, pnpm check, pnpm test, html-invariants.
            Dev probes per CLAUDE.md "Dev verification".
            Risk: low. No cluster smoke required (pure UI).
```

## Risks

1. **Spec drift between `docs/ui-guidelines.md` and `workflow-engine.css`.**
   Hex values in the doc and the CSS can diverge. Mitigation: the doc is the canonical reference; CLAUDE.md cross-links it; PR review enforces sync. We do not auto-generate the doc from CSS (no Style Dictionary build step) — that's overhead we don't need at our scale.

2. **"What breaks?" boundary cases.**
   Some claims sit on the line (e.g. is the green allowlist a contract or a convention?). Documented our reasoning explicitly in this design doc so future readers can see how we drew the line.

3. **The wordmark and Lucide changes touching multiple files in the same PR.**
   Mitigation: Phase 2 and Phase 3 are mechanical surgical edits; the diff is small (~40 lines total). Reviewable in one sitting.

4. **`html-invariants.test.ts` may need updates.**
   The CSP-cleanliness assertions stay; brand-mark assertions (if any) need to switch to wordmark assertions. Mitigation: update tests in the same PR as the structural touch-ups.

## Out of scope

- Migration of CLAUDE.md security invariants (no-inline, Alpine.data) into the new specs. They get a one-line cross-reference in CLAUDE.md to `ui-foundation` but stay primarily in CLAUDE.md per existing convention.
- Toast / notification component (no use case today).
- JSON-editor for trigger forms (current Jedison-driven forms keep their behaviour; only their appearance retheme via Phase 4).
- Sidebar collapse persistence (sidebar tree behaviour unchanged — appearance only).
- Brand-mark icon design (deferred indefinitely; wordmark is the brand).
- Per-page pixel-perfect mockups (`docs/ui-guidelines.md` documents component recipes, not full page layouts).
- Renaming existing specs (`shared-layout`, `dashboard-list-view`, `trigger-ui`).
- Generating the docs file from CSS via Style Dictionary or similar (overhead unnecessary at this scale).
