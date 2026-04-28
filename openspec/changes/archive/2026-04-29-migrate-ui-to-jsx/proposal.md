## Why

The runtime's HTML rendering inlines markup into TypeScript via Hono's `html\`...\`` tagged templates. This is hard to read for the larger surfaces (`flamegraph.ts` 1006 LOC, `dashboard/page.ts` 373, `trigger/page.ts` 543) where conditionals, recursion, and SVG markup are interleaved with logic. Server JSX via `hono/jsx` reads like HTML, keeps full TypeScript type safety, and is Hono-native — `c.html(<Page/>)` integrates with the existing handler/error pipeline without introducing a new rendering API.

## What Changes

- **Migrate 9 UI source files** from `html\`...\`` to server JSX (`.tsx`): `layout.ts`, `sidebar-tree.ts`, `triggers.ts`, `auth/login-page.ts`, `dashboard/page.ts`, `dashboard/flamegraph.ts`, `trigger/page.ts`, plus the two middleware files where `c.html(...)` is called (`dashboard/middleware.ts`, `trigger/middleware.ts`).
- **Add `icons.tsx`** — a new shared file holding icon components (`<DashboardIcon/>`, `<TriggerIcon/>`, `<BrandIcon/>`, `<ChevronIcon/>`). Replaces today's `iconPaths` map in `layout.ts`.
- **Add `error-pages.tsx`** — JSX components `<NotFoundPage/>` and `<ErrorPage/>` that compose `<Layout>`. Visible content unchanged (anonymous render, no user identity in topbar).
- **BREAKING (test infrastructure)**: replace string-regex assertions on rendered HTML in `dashboard/middleware.test.ts` and `trigger/middleware.test.ts` with DOM-level assertions via **linkedom** (new test-only devDep on `packages/runtime`). The CSP defence-in-depth regexes in `html-invariants.test.ts` stay as-is.
- **BREAKING (runtime API surface)**: 
  - `<Layout>` JSX component replaces the `renderLayout(options, content)` function. Trims props from 8 to 6: drops the `head`, `bodyAttrs`, and `owners` slots (all dead or vestigial today). `sidebarTree` drops its `Promise<HtmlEscapedString>` variant in favour of sync `JSX.Element`.
  - `AuthProvider.renderLoginSection(returnTo)` returns `JSX.Element` instead of `HtmlEscapedString`.
  - `Pages` interface in `content-negotiation.ts` reshapes from `{ notFound: string, error: string }` to `{ NotFoundPage, ErrorPage }` JSX components rendered per-request.
  - Per-surface `<script>` injection via the `head` slot is removed; the `<Layout>` component emits the full script set unconditionally on every page (Alpine, htmx, result-dialog, local-time, flamegraph, trigger-forms — ~32KB deferred, browser-cached after first visit).
- **BREAKING (static assets)**: `packages/runtime/src/ui/static/404.html` and `error.html` deleted; the route `GET /static/404.html` (previously served by static middleware) no longer exists. Rendering moves to per-request JSX via the global `notFound` / `onError` handlers.
- **Add JSX build config**: `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"` in `packages/runtime/tsconfig.json` only (runtime-local; other packages unaffected). No per-file pragmas.
- **Address Biome a11y findings** surfaced during migration. Biome's `a11y` rule group is already at `error` severity; many a11y rules are JSX-only and will start firing once `.tsx` files appear. Findings are fixed in-scope, not silenced via `biome-ignore`.
- **Delete dead code** uncovered during the audit: `bodyAttrs?` and `owners?` props on `LayoutOptions` (vestigial), the Promise variant on `sidebarTree`, the orphaned `static/owner-selector.js` file (referenced nowhere outside itself).

## Capabilities

### New Capabilities

None — this change exclusively reshapes existing capabilities.

### Modified Capabilities

- `shared-layout`: `renderLayout(options, content)` becomes a `<Layout>` JSX component with prop list trimmed; sidebarTree slot type changes; head slot removed.
- `auth`: `AuthProvider.renderLoginSection` return type changes from `HtmlEscapedString` to `JSX.Element`.
- `static-assets`: 404/error static HTML files removed; replaced by JSX components rendered per-request. `/static/404.html` direct-fetch route disappears; "loaded once at startup into in-memory cache" requirement reworded; "no user information" content invariant preserved.
- `http-server`: error-page rendering clause reworded — 404/5xx HTML is rendered per-request via JSX components instead of being build-time-bundled `?raw` strings.

## Impact

**Code**: 9 source files migrated to `.tsx`, 1 new file (`icons.tsx`), 1 new file (`error-pages.tsx`), 2 deleted (`static/404.html`, `static/error.html`), 1 deleted (`static/owner-selector.js`).

**APIs**: 
- Public-shape changes to `LayoutOptions` (now `LayoutProps` on `<Layout>`), `Pages` (in `content-negotiation.ts`), `AuthProvider.renderLoginSection`. All in-tree; no external consumers because the runtime is a single-binary deployable.
- No workflow-author-visible changes. `@workflow-engine/sdk` and the sandbox surface are untouched. Tenants do NOT need to rebuild or re-upload.

**Dependencies**:
- `packages/runtime` adds `linkedom` as a test-only devDep.
- `hono/jsx` is already available via the existing `hono` dependency; no new package install for the runtime path.

**Systems**:
- No state wipe; no manifest format change; no event-shape change; no wire-protocol change; no spec-prefix carve-outs.
- No change to CSP, `secure-headers.ts`, `NetworkPolicy`, or any infrastructure module.
- No change to the QuickJS sandbox or its plugin surface.

**Bundle size (operator-visible)**: every authenticated and unauthenticated UI page now ships the full `<script defer>` set (~32KB total: alpine + htmx + result-dialog + local-time + flamegraph + trigger-forms). Cost is one-time per browser per deploy; subsequent navigations hit the cache.

**Test surface**: `pnpm test` continues to be the gate. `html-invariants.test.ts` is unchanged. `dashboard/middleware.test.ts` and `trigger/middleware.test.ts` get 48 string-level assertions rewritten as linkedom-based DOM assertions. `flamegraph.test.ts` is untouched (the SVG body in `buildSvgPieces` stays as string concatenation; output bytes are byte-identical to today).
