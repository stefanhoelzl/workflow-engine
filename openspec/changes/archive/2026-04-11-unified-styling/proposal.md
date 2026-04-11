## Why

Static assets (JS, CSS) are scattered across middleware files as inline content. CSS is duplicated across `layout.ts`, `dashboard/page.ts`, and `trigger/middleware.ts` with shared patterns repeated in each. There is no shared CSS file, no centralized static serving, and no user identity displayed in the UI. This blocks Phase A (oauth2 custom templates) which needs a shared CSS file accessible at a stable URL.

## What Changes

- Extract all generic CSS into `src/ui/static/workflow-engine.css` (theme variables, dark mode, reset, component styles)
- Extract trigger inline JavaScript into `src/ui/static/trigger-forms.js`
- Create static file middleware that auto-discovers project files via `import.meta.glob` and serves vendor deps (Alpine.js, HTMX, Jedison) at `/static/*`
- Split `trigger/middleware.ts` — page rendering moves to `trigger/page.ts`
- Replace inline `<style>` in `layout.ts` with `<link href="/static/workflow-engine.css">`
- Add full-width top bar to layout: app branding left, username + sign-out + email right
- Add `user` and `email` parameters to `renderLayout()` from `X-Auth-Request-User`/`X-Auth-Request-Email` headers
- Remove JS serving routes from dashboard and trigger middleware
- Consolidate all static asset paths under `/static/` prefix
- Strip generic CSS from page-specific files, keeping only page-specific styles inline

## Capabilities

### New Capabilities

- `static-assets`: Static file serving middleware with build-time discovery and vendor dep imports, served at `/static/*` with immutable caching

### Modified Capabilities

- `shared-layout`: Layout switches from inline CSS to external stylesheet, gains top bar with user/email and sign-out link, sidebar loses title section
- `dashboard-middleware`: Removes JS serving routes, reads auth headers, passes user/email to page renderer
- `trigger-ui`: Page rendering extracted to separate file, inline JS extracted to static file, removes JS serving route, reads auth headers

## Impact

- **Code**: New files: `static/middleware.ts`, `static/workflow-engine.css`, `static/trigger-forms.js`, `trigger/page.ts`. Modified: `layout.ts`, `dashboard/middleware.ts`, `dashboard/page.ts`, `trigger/middleware.ts`, `main.ts`
- **Build**: First use of `import.meta.glob` in the codebase (Vite SSR feature)
- **Runtime**: Static assets served from memory with immutable cache headers. Auth headers read on all protected routes.
- **Infrastructure**: No changes in this phase (Traefik `/static` route added in Phase A)
