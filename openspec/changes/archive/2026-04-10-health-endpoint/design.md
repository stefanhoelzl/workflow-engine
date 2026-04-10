## Context

The workflow engine runs as a containerized service with DuckDB (in-memory event store), optional persistence (FS/S3), and HTTP trigger endpoints. There is currently no way for orchestrators, load balancers, or monitoring systems to determine if the service is alive, ready, or if its dependencies are healthy.

The codebase follows a middleware-based architecture with Hono. Each subsystem (dashboard, triggers, trigger UI) is a self-contained middleware factory that receives its dependencies and returns a `{ match, handler }` tuple. Health endpoints follow this same pattern.

## Goals / Non-Goals

**Goals:**
- Provide Kubernetes-compatible liveness (`/livez`) and readiness (`/readyz`) probes
- Provide an IETF-draft-compliant health check endpoint (`/healthz`) with per-component deep checks
- Expose webhook subsystem readiness via `GET /webhooks/`
- Measure and report check durations as observed values
- Make the implementation testable with the existing Vitest setup

**Non-Goals:**
- Metrics export (Prometheus, OpenTelemetry) — separate concern
- Authentication on health endpoints
- Health check history or trending
- Custom check plugins

## Decisions

### 1. Single file for all health routes

All three endpoints (`/livez`, `/readyz`, `/healthz`) live in `packages/runtime/src/health.ts` as a single middleware factory. They share check logic — splitting into multiple files would duplicate the check implementations.

**Alternative considered:** Separate files per endpoint. Rejected because the checks are shared and the total code is small.

### 2. Sequential check execution

Deep checks run sequentially, not in parallel. This makes failure attribution clear (if persistence:write fails, persistence:read is not attempted) and avoids concurrent load on dependencies during health checks.

**Alternative considered:** Parallel execution for speed. Rejected because health checks should minimize system load, and the total time (sum of checks) is bounded by the per-check timeout.

### 3. Per-check timeout with AbortSignal

Each deep check gets its own timeout (default 5s for `/readyz`, configurable via `?timeout=` on `/healthz`). Implemented with `AbortSignal.timeout()` where applicable (fetch calls). For non-abortable operations (DuckDB query, storage list), a `Promise.race` with a timeout rejects the check.

**Alternative considered:** Single timeout for all checks combined. Rejected because it makes it harder to identify which check is slow.

### 4. Reuse EventStore.query for health checks

The event store already exposes a `query` property (`db.selectFrom("events")`). The health check uses `eventStore.query.select(eb => eb.fn.countAll<number>().as("count")).executeTakeFirstOrThrow()` — no new API surface needed.

### 5. StorageBackend passed directly to health middleware

The health middleware receives the `StorageBackend` instance (or `undefined`). For the persistence check, it writes `.healthz/sentinel`, reads it back, and lists `pending/`. The sentinel file is not cleaned up — the recovery process ignores files that don't match the `{counter}_evt_{id}.json` pattern.

### 6. GET /webhooks/ on the existing trigger middleware

Rather than a separate middleware, the `httpTriggerMiddleware` handles `GET /webhooks/` directly. It already has access to the `HttpTriggerRegistry` and can check if any triggers are registered. Returns `204` (triggers loaded) or `503` (no triggers).

### 7. Domain check validates response content

The domain check fetches `BASE_URL + "/healthz"` and verifies: HTTP status is `200` AND response body contains `"status": "pass"`. This catches scenarios where a reverse proxy returns 200 with an error page.

## Risks / Trade-offs

**[Sentinel file accumulation]** → The `.healthz/sentinel` file is never deleted. Since it's a single file overwritten each time, there's no accumulation — the same path is reused. No risk.

**[/readyz fails in dev without BASE_URL/persistence]** → Intentional. Forces production parity. Developers use `/livez` or `/healthz` with specific params during local development.

**[Self-referential fetch in domain check]** → The health endpoint fetches itself via `BASE_URL`. If the server is overloaded, this could timeout or add load. Mitigated by the per-check timeout and the fact that `/healthz` (without params) is a trivial response.

**[DuckDB query timeout]** → DuckDB runs in-process with in-memory data. A `SELECT count(*)` on the events table should complete in microseconds. The 5s timeout is generous. If this times out, the process is likely in a bad state.
