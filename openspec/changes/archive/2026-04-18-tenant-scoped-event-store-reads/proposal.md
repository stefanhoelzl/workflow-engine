## Why

Security review F2 found that `GET /dashboard/invocations/:id/flamegraph` queries the event store by invocation id only, with no `tenant` filter — any authenticated dashboard user can retrieve any invocation's events (inputs, outputs, errors) for any tenant by guessing or observing the id. Masked today by the single-user GitHub allow-list, but it directly violates the SECURITY.md §4 invariant: "every query must be scoped by tenant."

The point fix is one helper signature. The deeper problem is the API shape: `eventStore.query` is an unscoped query builder that requires every caller to remember to add `.where("tenant", "=", t)`. The flamegraph is the first site to forget; it will not be the last. Closing the bug *and* the bug class together is cheap if done now (3 production callers) and grows expensive as more dashboard fragments are added.

## What Changes

- **BREAKING**: Replace the `EventStore.query` field (unscoped `SelectQueryBuilder`) with a `query(tenant: string)` method that returns a builder pre-bound with `.where("tenant", "=", tenant)`. Tenant becomes a required argument — there is no unscoped read path.
- **BREAKING**: Add `EventStore.ping(): Promise<void>` (executes `SELECT 1`) for the health check, which previously used the unscoped `query` to run `countAll()`.
- Migrate the three production callers to the new API:
  - `dashboard/middleware.ts` — `fetchInvocationRows` and `fetchInvocationEvents` take `tenant`; the flamegraph handler resolves the active tenant the same way the `/invocations` handler does, short-circuits to a 200 + empty fragment when there is no active tenant.
  - `recovery.ts` — `isArchived` accepts the tenant from each pending event (already on the event).
  - `health.ts` — eventstore check switches from `countAll()` to `ping()`.
- Add a regression test in `dashboard/middleware.test.ts`: a user who is a member of tenant A requesting the flamegraph for an invocation owned by tenant B receives the empty-state fragment with no event-data leakage.
- Update event-store and health-endpoints specs to reflect the schema's existing (but spec-stale) `tenant` column and the new tenant-scoped read API. Update dashboard-list-view spec for the per-tenant flamegraph endpoint and its enumeration-resistance posture.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `event-store`: `query` becomes a tenant-required method; new `ping()` method; `events` table schema requirement updated to include the (already-implemented) `tenant` column.
- `dashboard-list-view`: flamegraph endpoint requirement now scopes the event-store read by the active tenant; empty-state fragment is returned both when no active tenant is resolvable AND when the id is not found in the active tenant — the two cases SHALL be indistinguishable to the caller (enumeration-resistance).
- `health-endpoints`: eventstore check uses `ping()` (a `SELECT 1` round-trip) instead of `countAll()`; observed value remains the query duration.

## Impact

- **Code**: `packages/runtime/src/event-bus/event-store.ts` (API change), `packages/runtime/src/ui/dashboard/middleware.ts` (handler + helper), `packages/runtime/src/recovery.ts` (one helper signature), `packages/runtime/src/health.ts` (one check), plus their test files.
- **Tests**: `event-store.test.ts`, `dashboard/middleware.test.ts` (new regression case + `AUTH_HEADERS` retrofit on existing flamegraph tests), `health.test.ts` (stub rewrite), `recovery.test.ts` (signature touch-up if any).
- **Specs**: deltas in `event-store`, `dashboard-list-view`, `health-endpoints`.
- **External APIs**: none. The change is internal to the runtime; HTTP surface and on-disk formats are unchanged.
- **Security posture**: the F2 bug-class becomes structurally impossible. Cross-tenant enumeration via the flamegraph endpoint is closed.
- **Migration**: none for operators. No data migration, no config change. Internal callers update with the compiler's help (`query` field → `query(tenant)` method is a hard error at every call site).
