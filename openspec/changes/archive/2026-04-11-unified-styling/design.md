## Context

After Phase C (directory restructure), all UI code lives under `src/ui/`. CSS is inline in three places: `layout.ts` (~155 lines), `dashboard/page.ts` (~330 lines), and `trigger/middleware.ts` (~190 lines). Static JS files (Alpine.js, HTMX, Jedison) are loaded via `readFileSync` + `createRequire` in individual middleware files and served at inconsistent paths (`/dashboard/alpine.js`, `/trigger/jedison.js`).

The app has no user identity display. oauth2-proxy sets `X-Auth-Request-User` and `X-Auth-Request-Email` headers on authenticated routes via Traefik's forward auth, but the app ignores them.

## Goals / Non-Goals

**Goals:**
- Single shared CSS file (`workflow-engine.css`) with all generic/reusable styles
- Single static middleware serving all assets at `/static/*`
- Top bar showing authenticated user identity with sign-out link
- Clean separation: generic CSS in shared file, page-specific CSS stays inline
- Trigger page rendering extracted to its own file

**Non-Goals:**
- oauth2-proxy custom templates (Phase A)
- Traefik IngressRoute for `/static` (Phase A — in dev, the app serves directly)
- Extracting dashboard Alpine.js directives to separate files (Alpine x-data is declarative HTML)
- Responsive/mobile layout

## Decisions

### Static middleware uses `import.meta.glob` for project files + explicit imports for vendor deps

Project files in `src/ui/static/` are auto-discovered at build time via `import.meta.glob('./*', { query: '?raw', import: 'default', eager: true })`. Vendor deps (Alpine.js, HTMX, Jedison) use explicit `?raw` imports since they live in node_modules.

A content type whitelist maps extensions to MIME types (`.css` → `text/css`, `.js` → `application/javascript`). Files with unlisted extensions (including `middleware.ts` itself) are silently ignored.

**Alternative considered**: Manual entry list per file — rejected because it requires editing code to add new static files.

### CSS split: everything generic in `workflow-engine.css`, page-specific stays inline

Generic components used across pages (badges, banners, buttons, filters, tooltips, state dots, cards, page header) move to the shared CSS file. Page-specific styles (dashboard stats, timeline SVG, trigger accordion, Jedison overrides) stay inline in their respective `page.ts` files.

`body` in the shared CSS has no `display: flex` — each context handles its own layout (app uses fixed positioning + margins, oauth2 pages will use flex centering).

**Alternative considered**: Two CSS files (theme + components) — rejected as unnecessary complexity for the current scale.

### Unified `.page-header` class replaces `.header` and `.trigger-header`

Both dashboard and trigger have near-identical page header styles with different class names. These merge into a single `.page-header` class in the shared CSS.

### Top bar is part of layout, not per-page

A full-width top bar rendered by `renderLayout()` spans sidebar + content area. App branding ("W" icon + "Workflow Engine") on the left, user info + sign-out on the right. The sidebar loses its title section and becomes nav-only.

`renderLayout()` gains `user: string` and `email: string` parameters. Middleware reads these from `X-Auth-Request-User` and `X-Auth-Request-Email` headers. When empty (dev mode without oauth2-proxy), the user section is hidden.

### Trigger page split

`trigger/middleware.ts` is split into:
- `trigger/middleware.ts` — route handlers, banner renderers
- `trigger/page.ts` — `renderTriggerPage()`, `prepareSchema()`, `escapeHtml()`, page-specific CSS

The test file (`middleware.test.ts`) imports `prepareSchema` from the new `page.ts` location.

## Risks / Trade-offs

**[Risk] `import.meta.glob` untested in this codebase's SSR build** → Vite documents glob imports for SSR. If it fails, fall back to explicit `?raw` imports per file. Low risk.

**[Risk] `jedison/browser` `?raw` import may not resolve via package exports** → The `?raw` suffix might need the full file path rather than the exports entry. Test during implementation; fall back to `require.resolve` + `readFileSync` for this one file if needed.

**[Trade-off] Dead CSS in oauth2 pages** → The shared CSS includes sidebar/nav styles that oauth2 pages won't use. ~60 lines, negligible after gzip. Acceptable for single-file simplicity.

**[Trade-off] User section hidden in dev without oauth2-proxy** → Acceptable. The top bar still shows branding; user section appears when running with the infra stack.
