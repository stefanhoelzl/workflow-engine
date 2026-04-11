## Context

oauth2-proxy v7.15.1 supports custom templates via `--custom-templates-dir`. It expects `sign_in.html` and `error.html` as Go templates with access to variables like `{{.ProxyPrefix}}`, `{{.Redirect}}`, `{{.StatusCode}}`, and `{{.Message}}`. There is no sign-out template — sign-out is a redirect endpoint.

Phase B delivered `/static/workflow-engine.css` served by the app's static middleware. The oauth2-proxy templates need to reference this CSS via `<link>` tag. In the Kubernetes setup, Traefik routes `/static*` to the app service — this route must be unauthenticated since the sign-in page needs CSS before the user is logged in.

## Goals / Non-Goals

**Goals:**
- Sign-in page visually matches the app's theme (light/dark mode, same fonts, same accent color)
- Single sign-in template handles three states: normal, signed-out, auth error
- Error page redirects to sign-in with error context (no separate error UI to maintain)
- Template contents flow through OpenTofu module chain as data, not file paths

**Non-Goals:**
- Custom 404 page (future work)
- Changing the OAuth provider or auth flow
- Production deployment (Traefik route for `/static` works in dev; prod routing is a separate concern)

## Decisions

### Single sign-in template with query-param-driven banners

All three auth UI states (normal sign-in, post-sign-out, auth error) render from `sign_in.html`. State is conveyed via query parameters:
- `?info=<message>` → info banner (green/neutral)
- `?error=<message>` → error banner (red)
- No params → no banner

Client-side JS reads `location.search`, shows the appropriate banner, and cleans the URL with `history.replaceState`.

**Alternative considered**: Separate templates per state — rejected because oauth2-proxy only supports sign_in.html and error.html (no sign_out.html exists), and maintaining two visual templates doubles the styling surface.

### error.html as redirect shim

The error template renders no UI. It captures `{{.StatusCode}}` and `{{.Message}}` in a `<meta>` tag (HTML-escaped by Go's template engine), then JS reads the meta content and redirects to `/oauth2/sign_in?error=<encoded message>`.

Using `<meta>` for data transfer avoids Go template escaping issues in JavaScript string contexts — Go's `html/template` safely escapes values in HTML attribute positions.

**Alternative considered**: Encoding error data in URL fragments (`#error-403`) — rejected because query params are simpler and we want a single transport mechanism (query params for both sign-out and error).

### Template contents passed as variable, not file paths

`dev.tf` reads template files with `file()` and passes the contents as a `map(string)` through the module chain to `oauth2-proxy.tf`, which creates the ConfigMap. This keeps file I/O at the root level and makes the inner modules generic.

**Alternative considered**: Relative `file()` paths in `oauth2-proxy.tf` — rejected because it couples the inner module to the repo directory structure.

### Logout redirect URL includes query parameter

`OAUTH2_PROXY_LOGOUT_REDIRECT_URL` changes from `/oauth2/sign_in` to `/oauth2/sign_in?info=Signed+out`. oauth2-proxy redirects to this URL after clearing the session cookie. The sign-in template JS displays the message from the `info` query parameter.

## Risks / Trade-offs

**[Risk] CSS not loading on sign-in page if app is down** → If the app container isn't running, `/static/workflow-engine.css` returns an error and the sign-in page renders unstyled. In practice, if the app is down the user can't do anything useful anyway. The page remains functional (form still works) even without CSS.

**[Risk] Go template escaping of `{{.Message}}` in `<meta>` tag** → Go's `html/template` auto-escapes in HTML attribute context. A message containing `"` becomes `&quot;`, which `document.querySelector(...).content` decodes back to `"`. Safe by design.

**[Trade-off] Sign-in page makes an extra request for CSS** → One additional HTTP request for the stylesheet. Negligible — the CSS is ~5KB and cached with immutable headers after first load.
