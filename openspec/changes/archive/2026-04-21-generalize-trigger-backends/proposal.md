## Why

Today each `TriggerSource` is coupled to the executor: HTTP and cron sources call `executor.invoke(tenant, workflow, descriptor, input, bundleSource)` directly from their own code paths. The source also receives a heterogeneous `kindView` array where each entry carries `{tenant, workflow, bundleSource, descriptor}` — mixed identity and configuration in one shape. This works for HTTP and cron but doesn't scale to kinds that need per-backend I/O during reconfiguration (IMAP connection pool, SMTP listener, Kafka consumer group). Adding one of those today means threading executor/tenant/bundleSource plumbing through yet another file, and there's no way for a backend to report "your config is bad" (wrong IMAP credentials) vs "my infrastructure is bad" (IMAP server unreachable) — reconfigure is sync void, failures log only.

We want a generic trigger backend lifecycle where the registry hands each backend a **pre-wired callback per trigger** and the backend's only job is to route its native protocol event to that callback. Backends never touch `executor`, `tenant`, or `bundleSource`. The registry gets a clean per-tenant replacement contract, and backends can distinguish user-config errors from infrastructure errors so the upload API can return a meaningful 4xx vs 5xx.

## What Changes

- **BREAKING (internal runtime):** `TriggerSource.reconfigure(view)` → `TriggerSource.reconfigure(tenant, entries): Promise<ReconfigureResult>`. Each `TriggerEntry` carries `{descriptor, fire: (input: unknown) => Promise<InvokeResult<unknown>>}`. The backend no longer sees tenant, workflow, or bundleSource — those are captured inside the `fire` closure by the registry.
- **BREAKING (internal runtime):** `reconfigure` becomes async and returns a discriminated result — `{ok: true}` for success, `{ok: false, errors: TriggerConfigError[]}` for user-config failures (bad IMAP credentials). Throwing from `reconfigure` signals backend-infrastructure failure (IMAP server unreachable, port bind failed).
- **BREAKING (internal runtime):** `reconfigure` is scoped per-tenant. Calling `reconfigure(tenant, entries)` replaces everything previously tagged with that tenant for that kind; empty `entries` means the tenant's triggers of that kind are removed. Registry calls it once per backend per tenant upload.
- **NEW (internal runtime):** The registry builds `fire` closures via a non-generic `buildFire(executor, tenant, workflow, descriptor, bundleSource, validate)` helper. `fire(input)` runs Ajv against `descriptor.inputSchema`, then calls `executor.invoke(...)`. Backends never construct or wrap `fire` themselves.
- **BREAKING (API):** `POST /api/workflows/<tenant>` response differentiates error sources. Aggregated user-config errors across all backends → `400` with `{errors: [{backend, trigger, message}, ...]}`. Aggregated backend-infrastructure errors → `500` with `{errors: [...]}`. Manifest parsing failures remain `422` as today. If both classes occur, `400` wins (user-actionable first).
- **NEW (internal runtime):** Backends execute in parallel per upload (`Promise.allSettled`). No rollback: if one backend succeeds and another fails, the successful one stays at the new entries; storage is NOT updated on any failure (persist-on-full-success). Live state may diverge from storage until the tenant re-uploads; this is an explicit non-guarantee.
- **NEW (internal runtime):** An `allowedKinds` set on the registry is derived from the registered backend list. Manifests referencing an unknown `trigger.type` are rejected at parse time with a `422` (existing manifest-validation response class, augmented).

## Capabilities

### New Capabilities

None — this reshapes an existing capability (`triggers`) rather than introducing a new one.

### Modified Capabilities

- `triggers`: introduces the new `TriggerSource.reconfigure(tenant, entries): Promise<ReconfigureResult>` contract, the `TriggerEntry { descriptor, fire }` shape, error classification (`TriggerConfigError` vs thrown infra errors), and the lifecycle methods (`start`, `stop`, `reconfigure`). The old `reconfigure(view)` requirement is replaced.
- `workflow-registry`: the registry partitions entries per-tenant-per-kind, constructs `fire` via `buildFire`, and invokes each backend's `reconfigure(tenant, entries)` in parallel. Persist-on-full-success storage ordering. Unknown trigger kinds rejected at manifest parse against registered backend set.
- `http-trigger`: HTTP `TriggerSource` implementation adopts the new contract — its reconfigure logic is re-expressed in terms of `TriggerEntry`. The middleware calls `entry.fire(normalizedInput)` instead of `executor.invoke(...)`.
- `cron-trigger`: Cron `TriggerSource` implementation adopts the new contract — per-timer teardown/rearm is re-expressed per-tenant-scoped entry set. Ticks invoke `entry.fire({})`.
- `executor`: clarifies that `invoke` is called only from inside `fire` closures constructed by the registry; `TriggerSource` implementations MUST NOT call `executor.invoke` directly.
- `action-upload`: response shape gains the 4xx/5xx classification for reconfigure failures, with aggregated per-backend errors.

## Impact

**Code surface:**
- `packages/runtime/src/triggers/source.ts` — interface and shared types (`TriggerEntry`, `ReconfigureResult`, `TriggerConfigError`).
- `packages/runtime/src/triggers/http.ts` — rewrite against new contract. HTTP routing logic inside the source remains (configurable path with URLPattern — that separate simplification is scoped to the `fix-http-trigger-url` change).
- `packages/runtime/src/triggers/cron.ts` — rewrite against new contract.
- `packages/runtime/src/workflow-registry.ts` — notifySources becomes `reconfigureBackends`, partitions per-tenant-per-kind, awaits parallel calls, aggregates results. Storage write gated on full success. Unknown-kind rejection against registered set.
- `packages/runtime/src/workflow-registry.ts` + new helper — `buildFire` closure construction with Ajv validation.
- `packages/runtime/src/api/upload.ts` — map aggregated result → 400/500 with errors body.
- `packages/runtime/src/main.ts` — unchanged call shape (still `backends = [httpSource, cronSource]`); registry constructor receives the same list.

**No tenant action required:** this change does NOT alter the manifest schema, the SDK surface, or the bundle contents. Tenants do NOT need to re-upload. The only externally-visible change is the upload API's response on failure (4xx/5xx split with structured error body); successful uploads still return 2xx.

**No storage migration:** on-disk bundle layout (`workflows/<tenant>.tar.gz`) is unchanged. `pending/` and `archive/` prefixes are unchanged.

**Out of scope (tracked as separate changes):**
- `fix-http-trigger-url` workspace: removes `path`/`params` from `httpTrigger`, fixes URL to `/webhooks/<tenant>/<workflow>/<export-name>`.
- `sandbox-output-validation` workspace: enforces `descriptor.outputSchema` inside the sandbox.
- IMAP trigger backend: future change that exercises the new lifecycle; cited as motivation here but not added.

**Security invariants preserved:** `/webhooks/*` remains public and unauthenticated; `/api/*` remains behind `githubAuthMiddleware`; cross-tenant isolation in the registry (per-tenant reconfigure scoping) is unchanged in observable behavior.
