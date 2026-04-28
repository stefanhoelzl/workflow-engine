## Context

The runtime renders HTML via Hono's `html\`...\`` tagged template literals, defined across 9 files in `packages/runtime/src/ui/`. The largest (`flamegraph.ts` 1006 LOC, `trigger/page.ts` 543, `dashboard/page.ts` 373) interleave conditionals, recursion, and SVG with logic. Reading them is hard; the JSX equivalent reads like the HTML it produces.

The codebase is already aligned for this migration: handlers `await` data fetches before calling `c.html(...)`, so renderers receive already-resolved data structures. There are no async components, no streaming, no `<Suspense>` use cases. The Promise-typed slots on `LayoutOptions` (`head`, `sidebarTree`) are vestigial — every call site passes synchronous values.

Hono ships `hono/jsx` as part of the existing `hono` dependency. No new runtime package install is required for the runtime path. Vite + esbuild handle JSX automatically when given the right tsconfig settings.

A pre-implementation spike (run during exploration, scratch files cleaned up) verified the load-bearing behaviours: sync JSX renders correctly; async components in `renderToReadableStream` swallow thrown errors silently; SVG attributes (`viewBox`, `stroke-width`, `xmlns`) pass through verbatim; the `raw()` escape-bypass primitive works inside JSX trees. The spike's findings drove the "no async components" decision below.

## Goals / Non-Goals

**Goals:**
- Make HTML-rendering source files readable as HTML, end-to-end.
- Preserve every existing CSP invariant and XSS-escape contract (no `'unsafe-inline'`, no `on*=` handler attributes, no inline `<style>`).
- Preserve every observable HTTP behaviour (status codes, response bodies for the same inputs, `Accept`-branched JSON-vs-HTML negotiation on errors).
- Keep `pnpm validate` (lint + check + test) passing.
- Single source of truth for the layout chrome — error pages share `<Layout>` instead of duplicating its topbar.
- Address Biome a11y findings surfaced by `.tsx` files in-scope rather than silencing them.

**Non-Goals:**
- Streaming HTML responses. No surface streams today; introducing `<Suspense>` would add machinery for no benefit.
- Async components. The codebase pre-awaits data in handlers; async components would require error-handling machinery (the spike showed `renderToReadableStream` swallows thrown errors silently) for no ergonomic gain.
- Workflow-author-facing changes. `@workflow-engine/sdk` and the sandbox surface are untouched.
- Migrating `buildSvgPieces` in `flamegraph.tsx` to JSX. The SVG body is machine-generated, not human-authored markup; converting it would change output bytes (void-element re-pairing) and force a re-baseline of `flamegraph.test.ts` for no readability win.
- Migrating `html-invariants.test.ts` to DOM-level assertions. CSP defence-in-depth on raw output strings is the right tool there; that file uses regex on purpose and should keep doing so.
- Re-styling, restructuring URLs, changing routing, or introducing a client-side framework. JSX is server-rendered; no hydration; Alpine + htmx remain the client-side surfaces.

## Decisions

### Decision 1: Server JSX via `hono/jsx`, not a templating engine

**Choice**: `hono/jsx` server JSX, `.tsx` files, sync components.

**Rationale**: Most of the existing UI code is logic-heavy (conditionals, `.map()`, recursion, dynamic class composition). A static-template engine like Eta or Handlebars would force the logic into a second mini-language with weaker types and worse refactoring tooling. JSX expresses the same logic with full TypeScript inference and standard component composition, without leaving the TS file. It is also Hono-native: `c.html(<Page/>)` integrates with the existing handler/error pipeline.

**Alternatives considered**:
- *Eta / Handlebars* — best for designer-edited static HTML, weakest fit for the recursion in `sidebar-tree.ts` and the conditional branching in `flamegraph.ts`. Loses TS type safety on view data.
- *Extract only the static shell* — extracts `<!DOCTYPE>`-through-`<body>` from `layout.ts` into a `.html` file with placeholders; everything else stays as `html\`\``. Smallest diff but doesn't address the readability complaint for the large logic-heavy files.
- *Keep tagged templates, just split files harder* — addresses size, not syntax. Fails the "reads like HTML" goal.

### Decision 2: Sync JSX components only, no async

**Choice**: Every JSX component is a pure-sync function. All async work (registry reads, `EventStore.query`) stays in route handlers, before `c.html(...)` is called.

**Rationale**: The codebase already follows this pattern — `buildSidebarData(registry, ...)` is sync; middleware `await`s `eventStore.query(...)` before invoking renderers. The `Promise<HtmlEscapedString>` variant on `LayoutOptions.sidebarTree` and `LayoutOptions.head` is dead defensive typing — no caller passes a Promise. Preserving this boundary keeps the existing error contract (a thrown `await` in the handler propagates to `app.onError` → 500) without modification.

**Spike finding**: `renderToReadableStream` (used by Hono's `c.html(<Component/>)`) silently swallows errors thrown by async components, producing empty or fallback-stuck responses. Adopting async components would require introducing a per-component error-boundary protocol or a custom render wrapper. With sync components, none of that machinery is needed.

**Alternatives considered**:
- *Async components* — moves data fetch into components for "co-location"; spike showed silent error swallowing; the co-location benefit is illusory because fetches happen in handlers today.
- *`<Suspense>` + streaming* — useful for slow async leaves; this codebase has no slow leaves; same error-swallowing risk.

### Decision 3: Drop `head` slot; `<Layout>` emits the full `<script>` set unconditionally

**Choice**: Remove `LayoutOptions.head`. `<Layout>` always emits `<script defer>` tags for alpine, htmx, result-dialog, local-time, flamegraph, and trigger-forms.

**Rationale**: The `head` slot exists today only to inject `flamegraph.js` (4.4KB) on the dashboard and `trigger-forms.js` (9.8KB) on trigger pages. Browser-cached after first visit; deferred so render isn't blocked. Removing the slot collapses the `LayoutOptions` API and eliminates the `Promise<HtmlEscapedString>` type union. Single layout, single script-loading contract.

**Trade-off**: Anonymous users hitting a 404 download ~32KB of JS they may never reuse. Acceptable for an internal-tool workflow engine where anonymous traffic is rare; would be debatable for a public-facing site.

**Alternatives considered**:
- *Keep `head` slot as `JSX.Element`* — preserves per-surface customisation; preserves API complexity that exists for one use case (script tag injection).
- *Always-load only the universally-useful scripts; per-surface for the rest* — keeps the head slot under a different name; same complexity.

### Decision 4: Error pages use `<Layout>`, render per-request, anonymous

**Choice**: Add `error-pages.tsx` exporting `<NotFoundPage/>` and `<ErrorPage/>`. Compose `<Layout>` with `user=""`, `email=""`. `notFound` / `onError` handlers invoke them via `c.html(<NotFoundPage/>, 404)` — same delivery path as every other UI surface. Delete `static/404.html` and `static/error.html`.

**Rationale**: "Same way as other pages" is the operator-stated requirement: error pages share the layout chrome (topbar brand, theme, CSS) without duplicating it. Per-request rendering integrates with the existing handler pipeline.

**Privacy invariant preserved**: `user=""` is hard-coded; error pages never show signed-in identity. This is the same constraint expressed in `static-assets/spec.md` today ("but no user information") and prevents cross-user identity leak in scenarios where the request being served is not the request whose session caused the error.

**Trade-off**: `GET /static/404.html` direct fetch route disappears (the file is gone). No known consumer.

**Alternatives considered**:
- *Build-time render to `dist/static/404.html`* — preserves direct-fetch route; preserves the hand-authored static-file behaviour. Smallest spec disruption. Rejected because the operator requirement is "delivered the same way as other pages", which means per-request.
- *Per-request render with current user identity* — reuses `<Layout>` more fully; adds privacy-leak risk and a session-middleware-failure fallback path. Rejected on the privacy ground.

### Decision 5: Mixed render strategy in `flamegraph.tsx` — chrome JSX, SVG body string-concat

**Choice**: Migrate the 6 chrome render functions (`renderEmpty`, `renderLegend`, `buildMetrics`, `buildTriggeredBy`, `renderTriggerExceptionFragment`, `renderFlamegraph`) to JSX components. Leave `buildSvgPieces`, `renderRuler`, and the layout-math helpers as string-concatenation. Bridge via `{raw(svg)}` and `{raw(ruler)}` inside the top-level JSX.

**Rationale**: `buildSvgPieces` is machine-generated content — hundreds of `<rect>`, `<line>`, `<circle>`, `<text>`, `<path>` elements per render with computed coordinates. Nobody reads `<rect class="kind-action" x="42.13" y="6"/>`; readability isn't the optimisation target there. JSX-converting it would:
- Change output bytes (void elements pair-close: `<rect/>` → `<rect></rect>`, breaking `flamegraph.test.ts` assertions),
- Allocate hundreds of objects per render where today there are string appends,
- Add no readability beyond what `buildSvgPieces`'s structure already provides.

The chrome (legend, metrics, header, error-fragment, top-level wrapper) IS human-authored markup and benefits from JSX.

**Alternatives considered**:
- *Full JSX conversion* — uniform but pessimises bytes and perf for no readability win; forces re-baseline of `flamegraph.test.ts` (738 LOC, not in our test-migration scope).

### Decision 6: DOM-level test assertions via linkedom, uniformly

**Choice**: Replace all 48 string-level assertions in `dashboard/middleware.test.ts` and `trigger/middleware.test.ts` with DOM-level assertions parsed via `linkedom`. Add `linkedom` as a test-only devDep on `packages/runtime`. Provide a small `dom(html)` helper. `html-invariants.test.ts` stays as regex assertions.

**Rationale**: The existing assertions are a mix of pure-text (`.toContain("succeeded")`), attribute-as-string (`.toContain('id="inv-evt_pending"')`), and full-element regex (`.toMatch(/<span class="entry-trigger">inbound<\/span>/)`). The latter two are sensitive to attribute order, whitespace, and self-closing-tag style, all of which differ subtly between `html\`\`` and `hono/jsx` (per spike). A mixed regime ("rewrite only the brittle ones") leaves cognitive overhead on every future test edit; a uniform DOM regime gives one rule and converts even the "robust" pure-text assertions into more-scoped, more-meaningful checks (`.querySelector('.badge.succeeded').textContent`).

The CSP defence-in-depth file (`html-invariants.test.ts`) keeps its regex assertions because regex on raw output is the right tool against malformed/script-injected HTML that a parser might silently swallow.

**Alternatives considered**:
- *Selective DOM rewrite* (only attribute-string and full-regex assertions) — leaves a mixed idiom; future test authors must decide per assertion; drifts.
- *Keep string assertions, fix breakage as it appears* — no devDep; preserves brittleness; forces re-investigation on every JSX cosmetic tweak.

### Decision 7: JSX config in `packages/runtime/tsconfig.json` only, no per-file pragma

**Choice**: Add `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"` to `packages/runtime/tsconfig.json`. No per-file pragmas. No changes to `tsconfig.base.json`.

**Rationale**: JSX is a runtime-rendering concern. No other package (`core`, `sandbox`, `sdk`, `tests`) emits HTML or has any reason to know about JSX runtimes. Putting the settings in `tsconfig.base.json` would be the smallest-edit option but would pollute the type-emit of every other package with settings they don't use. Per-file pragmas are noisy and forgettable.

### Decision 8: DOCTYPE via `raw('<!DOCTYPE html>')` inside `<Layout>` fragment

**Choice**: `<Layout>` returns `<>{raw("<!DOCTYPE html>")}<html lang="en">…</html></>`.

**Rationale**: `c.html(<Layout/>)` does not auto-emit a DOCTYPE. Without it, browsers fall into quirks mode (different box model, CSS variables behave differently, `document.compatMode === "BackCompat"`). The cost of co-locating the DOCTYPE inside `<Layout>` is one line; the cost of skipping it is silent CSS regressions that surface as visual glitches.

**Alternatives considered**:
- *`hono/jsx`'s `jsxRenderer` middleware* (auto-emits DOCTYPE) — introduces a second rendering API (`c.render` alongside `c.html`); requires per-request prop-threading via `c.set`; makes specs talk about a different API. More ceremony for a one-line saving.
- *Skip the DOCTYPE* — silent CSS rendering regression. Rejected.

### Decision 9: New shared `icons.tsx` for icon components

**Choice**: Add `packages/runtime/src/ui/icons.tsx` exporting `<DashboardIcon/>`, `<TriggerIcon/>`, `<BrandIcon/>`, `<ChevronIcon/>` (and the trigger-kind icons currently in `triggers.ts`). Both `<Layout>` and `<SidebarTree>` import from there.

**Rationale**: Today `iconPaths` in `layout.ts` is the de-facto shared icon registry, and `sidebar-tree.ts` reaches across to use a `chevronIconSvg = raw(...)` constant. JSX components factor this naturally into a shared file. Each icon becomes a small component returning an `<svg>`; no `iconPaths` map, no `raw('<path .../>')` strings, no `biome-ignore` for the `noSecrets` rule.

## Risks / Trade-offs

**[Risk] Biome a11y findings surface late and bloat the PR.** → **Mitigation**: address them in-scope rather than silencing via `biome-ignore`; treat them as part of the migration's quality benefit. Initial survey shows 1 button without explicit `type=` and possibly a few `role`/`semantic-element` nudges. Bounded.

**[Risk] DOM-level assertions silently weaken or strengthen tests during rewrite.** → **Mitigation**: each assertion migrated 1:1 first (preserve intent); strengthening (e.g., `.toContain("succeeded")` → `.querySelector('.badge.succeeded').textContent === "succeeded"`) is opt-in and called out in PR description.

**[Risk] Anonymous 404 hits download ~32KB of unused JS.** → **Mitigation**: accept the trade-off (deferred, cached, internal-tool context). If a public-facing surface emerges later, reintroduce a per-surface script set then.

**[Risk] `flamegraph.tsx` mixed-strategy is criticised as inconsistent.** → **Mitigation**: design.md (this file) documents the two-natures rationale; comment in `flamegraph.tsx` itself points at the design doc; reviewers see the explicit choice rather than puzzling at it.

**[Risk] `/static/404.html` direct-fetch consumer surfaces post-deploy.** → **Mitigation**: low likelihood (no known consumer); if someone notices, a one-line static-route alias is easy to add as a follow-up. Not part of the contract worth preserving up-front.

**[Risk] SVG `xmlns` attribute pass-through under hono/jsx untested by the spike.** → **Mitigation**: the spike covered `viewBox`, `stroke-width`, `aria-hidden`, `class` — the pattern is identical for `xmlns`. A 1-line manual smoke during implementation closes any residual doubt.

**[Risk] Hono `c.html(<Layout/>)` rejection-handling under sync render path differs from `html\`\`` template path.** → **Mitigation**: spike confirmed sync renders propagate exceptions normally to `app.onError`; this is the today behaviour preserved bit-for-bit.

**[Trade-off] Per-request error-page render is slightly more CPU than today's startup-cached string.** → microseconds on a path that only runs for 404/500 responses. Not load-bearing.

**[Trade-off] linkedom is a new test-time dependency.** → ~50KB devDep, no production reach, well-maintained. Lighter than jsdom or happy-dom.
