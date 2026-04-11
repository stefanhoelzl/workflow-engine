## 1. Traefik Helm Configuration

- [x] 1.1 Add `traefik_inline_response` plugin to Traefik Helm values (`experimental.plugins` section)
- [x] 1.2 Enable `web` entrypoint (HTTP port 80) in Traefik Helm values without NodePort exposure
- [x] 1.3 Ensure the Traefik K8s Service includes port 80 for internal loopback access

## 2. New Middleware Definitions

- [x] 2.1 Add `not-found` errors middleware to `extraObjects` — intercepts 404, fetches `/static/404.html` from app service
- [x] 2.2 Add `server-error` errors middleware to `extraObjects` — intercepts 500-599, fetches `/error` from Traefik service on port 80
- [x] 2.3 Add `inline-error` plugin middleware to `extraObjects` — uses `traefik_inline_response` to serve self-contained 5xx HTML at `/error` path

## 3. IngressRoute Reorganization

- [x] 3.1 Add `/livez` route to no-auth whitelist (app service, no middleware)
- [x] 3.2 Add `/api/*` route to app-auth category (app service, server-error middleware)
- [x] 3.3 Add catch-all `/*` route with low priority (app service, not-found middleware)
- [x] 3.4 Add `not-found` and `server-error` middleware to `/dashboard/*` and `/trigger/*` routes (alongside existing oauth2 middleware)
- [x] 3.5 Add `server-error` middleware to `/webhooks/*` route
- [x] 3.6 Remove error middleware from `/static/*`, `/oauth2/*`, `/livez`, and `/` routes (these keep no error middleware)
- [x] 3.7 Add error page IngressRoute on `web` entrypoint — `Path('/error')` with `inline-error` middleware and `noop@internal` service

## 4. Error Pages

- [x] 4.1 Create `404.html` in `packages/runtime/src/ui/static/` — uses shared CSS, top bar with brand, "Page not found" message, link to `/dashboard/`
- [x] 4.2 Write the inline 5xx HTML content for the `traefik_inline_response` plugin config — self-contained card layout matching sign-in page style, dark mode support, "Try again" button

## 5. Static Middleware Update

- [x] 5.1 Add `.html` to the content type whitelist in the static middleware so `404.html` is served with `Content-Type: text/html`

## 6. Validation

- [x] 6.1 Run `pnpm validate` to verify lint, format, type checks, and tests pass
- [x] 6.2 Deploy with `pnpm infra:up:build` and verify: unknown paths show styled 404, authenticated routes work, `/livez` responds, `/api/*` is accessible, `/static/*` serves normally
