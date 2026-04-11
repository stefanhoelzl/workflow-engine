## 1. Create templates

- [x] 1.1 Create `infrastructure/templates/sign_in.html`: links to `/static/workflow-engine.css`, branded centered card with "W" icon + "Workflow Engine" + "Sign in to continue", GET form to `{{.ProxyPrefix}}/start` with hidden `rd` field, GitHub SVG button, JS reads `?info` and `?error` query params to show banners, cleans URL with `history.replaceState`
- [x] 1.2 Create `infrastructure/templates/error.html`: `<meta name="error" content="{{.StatusCode}} {{.Message}}">`, JS reads meta content and redirects to `{{.ProxyPrefix}}/sign_in?error=<encoded>`

## 2. Update oauth2-proxy infrastructure

- [x] 2.1 Add `oauth2_templates` variable (`map(string)`) to `workflow-engine.tf` and pass it to `oauth2-proxy` module
- [x] 2.2 Add `templates` variable (`map(string)`) to `oauth2-proxy.tf`, create `kubernetes_config_map_v1` from it
- [x] 2.3 Add volume and volume mount to oauth2-proxy deployment: mount ConfigMap at `/templates`
- [x] 2.4 Add `OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR=/templates` env var to oauth2-proxy container
- [x] 2.5 Change `OAUTH2_PROXY_LOGOUT_REDIRECT_URL` from `/oauth2/sign_in` to `/oauth2/sign_in?info=Signed+out`

## 3. Update routing

- [x] 3.1 Add unauthenticated IngressRoute rule: `PathPrefix('/static')` → app service, no middleware

## 4. Wire up dev stack

- [x] 4.1 Update `dev.tf`: read template files with `file()`, pass as `oauth2_templates` map to `workflow-engine` module

## 5. Validate

- [x] 5.1 Run `tofu fmt -check -recursive infrastructure/` and `tofu -chdir=infrastructure/dev validate`
- [x] 5.2 Run `pnpm validate` — all checks must pass
