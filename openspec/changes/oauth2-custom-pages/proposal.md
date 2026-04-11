## Why

The oauth2-proxy sign-in and error pages use the default Bulma-styled templates that look nothing like the app. Now that Phase B delivered a shared CSS file at `/static/workflow-engine.css` and a `/static/*` route in the app, the oauth2-proxy templates can reference that CSS to match the app's visual identity. This is the final step in the unified styling initiative.

## What Changes

- Create custom `sign_in.html` template with branded card, GitHub sign-in button, and contextual banners for sign-out and error states (all driven by query parameters)
- Create `error.html` redirect shim that encodes the error into a query parameter and redirects to the sign-in page
- Add `kubernetes_config_map_v1` resource with template contents, mounted into the oauth2-proxy pod
- Add `OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR` env var to oauth2-proxy container
- Change `OAUTH2_PROXY_LOGOUT_REDIRECT_URL` to include `?info=Signed+out` query parameter
- Add unauthenticated `/static*` IngressRoute rule in Traefik routing
- Pass template file contents through the module chain via a new `oauth2_templates` variable

## Capabilities

### New Capabilities

_None — custom pages are part of the oauth2-proxy capability._

### Modified Capabilities

- `oauth2-proxy`: Custom sign-in and error templates via ConfigMap volume mount, updated logout redirect URL, custom templates dir env var
- `infrastructure`: New `/static` IngressRoute rule for unauthenticated static asset access

## Impact

- **Infrastructure**: Changes to `oauth2-proxy.tf` (ConfigMap, volume, env vars), `workflow-engine.tf` (new variable), `routing.tf` (new route), `dev.tf` (read template files)
- **New files**: `infrastructure/templates/sign_in.html`, `infrastructure/templates/error.html`
- **Runtime**: No app code changes — templates reference existing `/static/workflow-engine.css` served by Phase B's static middleware
