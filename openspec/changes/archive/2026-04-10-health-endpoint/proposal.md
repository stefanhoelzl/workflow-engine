## Why

The workflow engine has no way to signal whether it is alive, ready to serve traffic, or whether its dependencies (event store, persistence, external reachability) are healthy. Container orchestrators, load balancers, and monitoring systems need standardized endpoints to make routing and restart decisions.

## What Changes

- Add three health endpoints following established standards:
  - `GET /livez` — liveness probe (server alive)
  - `GET /readyz` — readiness probe (all dependencies healthy, fails if any unconfigured)
  - `GET /healthz` — IETF health check with per-component deep checks via query params
- Add `GET /webhooks/` returning `204` when triggers are loaded, `503` when not
- Add optional `BASE_URL` environment variable for self-reachability checks
- Expose a `query` property on `EventStore` for direct query access
- Response format follows [IETF Health Check Response Format](https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check-06) (`application/health+json`, `"pass"`/`"fail"` status values)

## Capabilities

### New Capabilities
- `health-endpoints`: Liveness, readiness, and IETF health check endpoints with deep dependency checks (eventstore, persistence, webhooks, domain)
- `webhooks-status`: `GET /webhooks/` returns subsystem readiness via HTTP status code

### Modified Capabilities
- `runtime-config`: Add optional `BASE_URL` env var
- `event-store`: Expose `query` property for direct `selectFrom("events")` access
- `http-server`: Wire new health and webhooks-status middleware into the server

## Impact

- **New file**: `packages/runtime/src/health.ts`
- **Modified files**: `event-store.ts` (query property), `config.ts` (BASE_URL), `main.ts` (wiring), `triggers/http.ts` (GET /webhooks/), `triggers/http.test.ts` (update /api/health test)
- **New env var**: `BASE_URL` (optional)
- **Content-Type**: Introduces `application/health+json` responses
- **No breaking changes**: All new endpoints, no existing behavior modified
- **No QueueStore changes**: Health checks read state, don't modify the queue
- **No manifest changes**: No build-time impact
