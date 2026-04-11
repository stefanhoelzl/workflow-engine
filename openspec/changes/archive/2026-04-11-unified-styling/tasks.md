## 1. Create shared CSS file

- [x] 1.1 Create `src/ui/static/workflow-engine.css` with all generic CSS extracted from `layout.ts` (theme variables, dark mode, reset, body, sidebar, nav, scrollbar, `[x-cloak]`), `dashboard/page.ts` (page-header, badges, state-dots, pulse animation, filters, entry cards, chevron, tooltip, copy-btn, empty-state, content-list), and `trigger/middleware.ts` (banners, submit-btn)
- [x] 1.2 Add top bar styles to `workflow-engine.css`: `.topbar`, `.topbar-brand`, `.topbar-brand .icon`, `.topbar-user`, `.topbar-username`, `.topbar-signout`
- [x] 1.3 Rename `.header` and `.trigger-header` to unified `.page-header` class in the CSS

## 2. Extract trigger JavaScript and page rendering

- [x] 2.1 Create `src/ui/static/trigger-forms.js` with `EditorInlineMultiple` class, `initForm()`, and `submitEvent()` extracted from `trigger/middleware.ts` inline `<script>`
- [x] 2.2 Create `src/ui/trigger/page.ts` with `renderTriggerPage()`, `prepareSchema()`, and `escapeHtml()` extracted from `trigger/middleware.ts`, keeping only page-specific inline CSS (trigger-content, event-details, event-summary, event-name, event-body, form-container Jedison overrides)
- [x] 2.3 Update `trigger/middleware.ts`: remove page rendering, inline JS, and Jedison serving route. Import `renderTriggerPage` from `./page.js`. Keep route handlers and banner renderers.
- [x] 2.4 Update `trigger/middleware.test.ts`: import `prepareSchema` from `./page.js` instead of `./middleware.js`

## 3. Create static middleware

- [x] 3.1 Create `src/ui/static/middleware.ts`: use `import.meta.glob('./*', { query: '?raw', import: 'default', eager: true })` for project files, explicit `?raw` imports for vendor deps (Alpine.js, HTMX, Jedison), content type whitelist (`.css` → `text/css`, `.js` → `application/javascript`), serve at `/static/*` with immutable cache headers

## 4. Update layout

- [x] 4.1 Update `src/ui/layout.ts`: replace inline `<style>` with `<link rel="stylesheet" href="/static/workflow-engine.css">`, update script tags to `/static/alpine.js` and `/static/htmx.js`
- [x] 4.2 Add `user` and `email` fields to `LayoutOptions` interface
- [x] 4.3 Replace sidebar title section with full-width top bar: branding left, user/email/sign-out right. Hide user section when user is empty. Sidebar becomes nav-only starting below top bar.

## 5. Update dashboard

- [x] 5.1 Update `src/ui/dashboard/page.ts`: remove all generic CSS that moved to `workflow-engine.css`, rename `.header` to `.page-header` in remaining CSS and HTML, accept `user` and `email` parameters and pass to `renderLayout()`
- [x] 5.2 Update `src/ui/dashboard/middleware.ts`: read `X-Auth-Request-User` and `X-Auth-Request-Email` headers, pass to `renderPage()`. Remove Alpine.js and HTMX `readFileSync` + serving routes, remove `createRequire` import.

## 6. Update trigger middleware

- [x] 6.1 Update `src/ui/trigger/middleware.ts`: read `X-Auth-Request-User` and `X-Auth-Request-Email` headers, pass to `renderTriggerPage()`

## 7. Wire up and validate

- [x] 7.1 Update `src/main.ts`: import and add static middleware to `createServer()` call
- [x] 7.2 Run `pnpm validate` — all lint, format, type check, and tests must pass
