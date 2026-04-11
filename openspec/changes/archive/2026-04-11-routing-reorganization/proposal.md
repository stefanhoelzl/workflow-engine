## Why

The current Traefik routing requires each route to explicitly opt into oauth2-proxy authentication middleware. Forgetting middleware on a new route silently exposes it without authentication. Additionally, there is no catch-all for unknown paths (they get Traefik's default response) and no custom error pages for 404 or 5xx responses. Reorganizing into explicit whitelists with a deny-by-default catch-all makes the routing less error-prone and gives users clear feedback on bad URLs or server errors.

## What Changes

- **Routing model**: Replace the current per-route opt-in auth model with explicit whitelists (auth whitelist, no-auth whitelist, app-auth) and a catch-all that serves a 404 page.
- **New routes**: Add `/livez` (no-auth), `/api/*` (app-auth), and `/*` catch-all (404) to Traefik IngressRoutes.
- **404 error page**: Add a styled 404.html to the app's static assets (shared CSS + top bar). A new Traefik `errors` middleware intercepts 404 responses from the app and serves this page.
- **5xx error page**: Add a self-contained inline 5xx error page served via the `traefik_inline_response` plugin on an internal HTTP-only loopback entrypoint. A new Traefik `errors` middleware intercepts 500-599 responses and fetches the error page via this loopback.
- **Traefik plugin**: Install the `traefik_inline_response` plugin (by tuxgal) in the Traefik Helm configuration.
- **Internal web entrypoint**: Enable Traefik's `web` entrypoint (HTTP port 80) without NodePort exposure, used only for the 5xx error page loopback.
- **`not-found` middleware**: New Traefik `errors` middleware intercepting 404 responses, fetching `/static/404.html` from the app. Applied to all app-serving routes.
- **`server-error` middleware**: New Traefik `errors` middleware intercepting 500-599 responses, looping back to Traefik's internal web entrypoint. Applied to all app-serving routes except `/static/*`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `infrastructure`: Routing requirements change — new whitelist-based routing model, new middlewares, new routes, Traefik plugin installation, internal web entrypoint.
- `static-assets`: Add 404.html to the static file set, add 5xx error page (inline via Traefik plugin), define error middleware scope.

## Impact

- **Infrastructure (Terraform)**: `routing.tf` is the primary change — new middlewares, reorganized IngressRoute rules, plugin config, web entrypoint. Traefik Helm values change to add the plugin and entrypoint.
- **App (static assets)**: New `404.html` file in `packages/runtime/src/ui/static/`.
- **No app code changes**: The app's middleware handlers, health endpoints, and API auth are unchanged. Routing changes are purely at the Traefik/infrastructure layer.
- **Dependencies**: `traefik_inline_response` plugin (external, Apache-2.0, actively maintained).
