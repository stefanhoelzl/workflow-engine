## Context

Traefik routes requests to the workflow-engine app and oauth2-proxy via IngressRoute CRDs defined in `infrastructure/modules/workflow-engine/modules/routing/routing.tf`. Currently, each route explicitly opts into oauth2-proxy authentication middleware. There are 6 routes: `/` (redirect), `/oauth2/*`, `/static/*`, `/webhooks/*`, `/dashboard/*`, `/trigger/*`. The `/api/*` and `/livez` paths are not exposed through Traefik at all. Unknown paths receive Traefik's default response with no custom error page.

The app serves static assets from `packages/runtime/src/ui/static/` via the static middleware at `/static/*`. The oauth2-proxy templates (`sign_in.html`, `error.html`) live in `infrastructure/templates/` and are mounted via ConfigMap.

## Goals / Non-Goals

**Goals:**
- Make authentication the structural default — new routes must be explicitly whitelisted to be accessible
- Serve styled 404 pages for unknown paths (app-served, shared CSS + top bar)
- Serve self-contained 5xx error pages when the app errors (via Traefik plugin loopback, no app dependency)
- Expose `/api/*` and `/livez` through Traefik
- Make the routing config self-documenting with clear whitelist categories

**Non-Goals:**
- Changing the app's HTTP middleware stack or endpoint definitions
- Custom error pages when the app is completely unreachable (Traefik's default 502 is acceptable for this case)
- Per-status-code error pages (one 404 page, one 5xx page)
- Exposing `/healthz` or `/readyz` through Traefik (K8s probes access these directly on the pod)

## Decisions

### D1: Explicit whitelists with deny-by-default catch-all

Routes are organized into four categories. Everything not listed gets a 404.

| Category | Routes | Middleware | Purpose |
|---|---|---|---|
| **Auth whitelist** | `/dashboard/*`, `/trigger/*` | oauth2-errors + oauth2-forward-auth + not-found + server-error | OAuth2-protected UI pages |
| **No-auth whitelist** | `/` (redirect), `/oauth2/*`, `/static/*`, `/webhooks/*`, `/livez` | Varies per route | Public endpoints |
| **App-auth** | `/api/*` | server-error | App validates GitHub tokens internally |
| **Catch-all** | `/*` (low priority) | not-found | Returns 404 for all unrecognized paths |

**Alternative considered**: Entrypoint-level default auth middleware (all routes authenticated unless opted out). Rejected because the default behavior for unknown paths should be 404, not authentication. The catch-all deny pattern is more explicit and the auth/no-auth distinction is visible in one place.

### D2: 404 page served by the app via Traefik `errors` middleware

A new `not-found` Traefik `errors` middleware intercepts HTTP 404 responses from the app and replaces the body with content fetched from the app's `/static/404.html`. This works because 404 means the app is running — it just doesn't have a handler for the requested path.

The `not-found` middleware is applied to all routes that serve from the app (auth whitelist, app-auth, and catch-all). It is NOT applied to `/static/*` or `/oauth2/*` since those serve their own content.

The `404.html` file uses the shared `workflow-engine.css` and includes the top bar (brand only, no user info since the request may be unauthenticated). A "Go to dashboard" link provides navigation back to the authenticated area.

**Alternative considered**: Serve 404 inline via the same Traefik plugin used for 5xx. Rejected because the app-served page can use the shared CSS and top bar, providing a richer experience. The app is guaranteed to be healthy for 404 responses.

### D3: 5xx page via Traefik self-loopback with `traefik_inline_response` plugin

A new `server-error` Traefik `errors` middleware intercepts HTTP 500-599 responses. It fetches the error page from Traefik's own K8s Service on the internal `web` (HTTP port 80) entrypoint. On that entrypoint, an IngressRoute with the `traefik_inline_response` middleware plugin serves self-contained inline HTML.

```
Request flow (5xx):

  Client ──▶ Traefik :443 ──▶ App :8080
                                  │ returns 5xx
              server-error MW ◀───┘
                  │
                  │ fetches /error from traefik:80
                  ▼
              Traefik :80 (web entrypoint)
                  │
              /error route
              traefik_inline_response MW
                  │ serves inline HTML
                  ▼
              Response ──▶ Client (styled 5xx page)
```

The `web` entrypoint (port 80) is enabled without a NodePort — it's only accessible within the cluster via the Traefik K8s Service. This avoids TLS issues (the `errors` middleware makes plain HTTP requests, and the `websecure` entrypoint expects TLS).

The inline HTML is self-contained with inline styles matching the project's design language (same colors, fonts, card layout as sign-in page). It must be self-contained because the app's `/static/*` assets may be unavailable when the app is erroring.

**Plugin choice**: `traefik_inline_response` by tuxgal (Apache-2.0). Actively maintained (last commit Jan 2026), no known bugs. Supports path matching and custom status codes. Go's automatic MIME sniffing correctly detects HTML content.

**Alternative considered**: Serving 5xx from oauth2-proxy. Rejected because oauth2-proxy doesn't have a suitable endpoint for generic error pages — its error template only triggers on internal auth errors, not arbitrary HTTP requests.

**Alternative considered**: Separate nginx container for error pages. Rejected as over-engineering for a dev environment. The plugin loopback approach requires no additional containers.

### D4: Traefik Helm chart changes

The Traefik Helm release needs three additions:
1. **Plugin installation**: Add `traefik_inline_response` to `experimental.plugins` in Helm values
2. **Web entrypoint**: Enable `ports.web` (port 80) with `exposedPort: null` or equivalent to prevent NodePort exposure
3. **Service port**: Ensure the Traefik K8s Service includes port 80 for the loopback

All middleware and IngressRoute definitions continue to use the `extraObjects` pattern (Helm chart deploys them alongside CRDs to avoid timing issues on first apply).

### D5: Error middleware scope

| Middleware | Applied to |
|---|---|
| `not-found` (404) | `/dashboard/*`, `/trigger/*`, `/api/*`, `/webhooks/*`, `/*` catch-all |
| `server-error` (5xx) | `/dashboard/*`, `/trigger/*`, `/api/*`, `/webhooks/*` |

Not applied to `/static/*` (static assets should return their native status codes), `/oauth2/*` (oauth2-proxy manages its own errors), `/livez` (health probes should return raw status), or `/` (redirect only).

The catch-all does NOT get `server-error` because it only exists to produce 404s — a 5xx from the catch-all would indicate a deeper problem where the loopback likely also fails.

## Risks / Trade-offs

**[Traefik plugin dependency]** → The `traefik_inline_response` plugin is a small open-source project (5 stars). Mitigation: the plugin is simple Go code (request path matcher + inline response), easy to fork if abandoned. The plugin only affects the 5xx error page — the rest of the routing works without it.

**[Loopback failure when Traefik is degraded]** → If Traefik's web entrypoint is unhealthy, the 5xx error middleware can't fetch the error page. Mitigation: this is an edge case (Traefik itself must be healthy to route the original request). If the loopback fails, the client sees the raw 5xx from the app, which is acceptable.

**[404 page depends on app serving /static/*]** → If the static middleware is broken, the `not-found` error middleware fetch to `/static/404.html` also fails. Mitigation: static file serving is one of the simplest code paths in the app. If it's broken, there are bigger problems. The client would see the raw 404, which is still informative.

**[Web entrypoint exposure]** → The HTTP port 80 entrypoint must not be externally accessible. Mitigation: no NodePort is configured for it. In the kind cluster, only port 30443 is mapped to the host. The web entrypoint is only reachable from within the cluster network.
