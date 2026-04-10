## 1. Configuration

- [x] 1.1 Add optional `BASE_URL` env var to config schema in `config.ts`, mapped to `baseUrl`

## 2. Webhooks Status Endpoint

- [x] 2.1 Add `GET /webhooks/` handler to `httpTriggerMiddleware` — return `204` if registry has triggers, `503` if empty
- [x] 2.2 Update `http.test.ts` — replace `/api/health` 404 test with tests for `GET /webhooks/` (204 with triggers, 503 without)

## 3. Health Middleware

- [x] 3.1 Create `packages/runtime/src/health.ts` with `healthMiddleware` factory accepting `{ eventStore, storageBackend, baseUrl }`
- [x] 3.2 Implement `GET /livez` — return `200` with `{"status":"pass"}` and `application/health+json`
- [x] 3.3 Implement `GET /healthz` — shallow (no params) returns same as `/livez`; with query params runs requested checks sequentially
- [x] 3.4 Implement eventstore check — `fn.countAll()` via `eventStore.query`, measure duration, report as `componentType: "datastore"`
- [x] 3.5 Implement persistence checks — `persistence:write` (write `.healthz/sentinel`), `persistence:read` (read it back), `persistence:list` (list `pending/`), each with duration, report `"no backend configured"` if no backend
- [x] 3.6 Implement webhooks check — `fetch(baseUrl + "/webhooks/")`, expect `204`, measure duration, report `"BASE_URL not configured"` if no baseUrl
- [x] 3.7 Implement domain check — `fetch(baseUrl + "/healthz")`, verify `200` + `"status":"pass"` in body, measure duration, report `"BASE_URL not configured"` if no baseUrl
- [x] 3.8 Implement per-check timeout — `Promise.race` with configurable timeout (default 5s), report `"timeout after Xms"` on expiry
- [x] 3.9 Implement `?timeout=` query param on `/healthz` to override default timeout
- [x] 3.10 Implement `GET /readyz` — run all checks sequentially with hardcoded 5s timeout, no query params, fail if any dep unconfigured

## 4. Wiring

- [x] 4.1 Wire `healthMiddleware` into `createServer` in `main.ts`, passing eventStore, storageBackend, and config.baseUrl

## 5. Tests

- [x] 5.1 Test `/livez` returns `200` with correct content-type and body
- [x] 5.2 Test `/healthz` shallow returns `200` with `{"status":"pass"}`
- [x] 5.3 Test `/healthz?eventstore=true` runs eventstore check and returns IETF format with duration
- [x] 5.4 Test `/healthz?persistence=true` without backend returns `503` with `"no backend configured"` for all three persistence checks
- [x] 5.5 Test `/healthz?persistence=true` with backend runs write/read/list and returns pass with durations
- [x] 5.6 Test `/healthz?webhooks=true` and `?domain=true` without `BASE_URL` return `503` with `"BASE_URL not configured"`
- [x] 5.7 Test `/healthz?timeout=100` applies custom timeout
- [x] 5.8 Test `/readyz` with all deps configured and healthy returns `200`
- [x] 5.9 Test `/readyz` with missing deps returns `503` with failures for unconfigured checks
