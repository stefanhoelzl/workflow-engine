## Context

`EventStore` exposes `query: SelectQueryBuilder<Database, "events", object>` as a public field. Every read site is responsible for adding `.where("tenant", "=", tenant)`. The `events` table has a `tenant` column (added in the multi-tenant-workflows change) but the spec does not yet mention it, and the API does not enforce its use.

Three production callers read the event store today:

| Site | Tenant scoped today | Need today |
| --- | --- | --- |
| `dashboard/middleware.ts` `fetchInvocationRows` | yes | per-tenant list |
| `dashboard/middleware.ts` `fetchInvocationEvents` | **no** (F2 bug) | per-tenant lookup |
| `recovery.ts` `isArchived` | no (cross-tenant) | "any tenant has this id" |
| `health.ts` eventstore check | n/a (`countAll`) | DB liveness |

(Plus stub usages in tests.)

Audit confirms there is no fourth production read site. The non-scoped callers (`recovery`, `health`) are refactorable into the scoped API without semantic change: ids are globally unique in practice (UUID + `(id, seq)` PK collision-prevention), and the health check is better served by a `SELECT 1` than a `count(*)`.

## Goals / Non-Goals

**Goals:**

- Make tenant scoping a structural property of the EventStore read API: a developer cannot accidentally produce an unscoped read in user-facing code paths.
- Close F2 (cross-tenant flamegraph leak) as a side effect of migrating the dashboard helper to the new API — the bug fix is the migration.
- Keep the API ergonomic: chaining `.where`, `.select`, etc. continues to work; tenant is one extra argument at the entry point.
- Update specs (`event-store`, `dashboard-list-view`, `health-endpoints`) to reflect both the existing-but-undocumented `tenant` column and the new tenant-required read shape.

**Non-Goals:**

- Cross-tenant aggregates. If a future feature needs them, it must iterate `registry.tenants()` and aggregate explicitly. We do not want a generic unscoped escape hatch.
- Physical per-tenant sharding. The change is API-shape only; the underlying DuckDB table stays single-tenant-column.
- Wider security review (F1 header-stripping, F3 S3 credentials) — those are tracked separately.
- Trigger/registry tenancy. Already correctly scoped; no change.

## Decisions

### 1. `query` becomes a method, `tenant` is a required argument

Replace:

```ts
readonly query: SelectQueryBuilder<Database, "events", object>;
```

with:

```ts
query(tenant: string): SelectQueryBuilder<Database, "events", object>;
```

The returned builder is pre-bound with `.where("tenant", "=", tenant)`. Callers chain further predicates as before.

**Why this over alternatives:**

- `eventStore.scopedTo(tenant).query` (chained accessor) — same effect, more typing at every call site, no real benefit.
- Keep `.query`, add `.scopedQuery(tenant)` — leaves the wrong path discoverable. The point is to remove it.
- Type-tagged factories (different `EventStore` types for system vs user-facing code) — strongest, but type machinery has a real maintenance cost and the migration is invasive. The function-arg approach is enough: there is exactly one method, and tenant is a required positional arg.

A tenant cannot be "removed" from the query later (Kysely `.where` clauses are additive; there is no `.unsetWhere`), so the binding is sticky. Worst case if a caller adds a contradictory predicate — `.where("tenant", "=", "other")` after `.where("tenant", "=", t)` — is empty results, not data leak.

### 2. Add `EventStore.ping(): Promise<void>` for the health check

The current health check runs `SELECT count(*) FROM events`. The semantic intent is "can we talk to the store?" — a row count is overkill (O(rows) instead of O(1)) and would require either a tenant arg (arbitrary choice) or an unscoped escape hatch.

`ping()` issues `SELECT 1` via the underlying DuckDB connection, returns the duration to the caller via the existing `timed()` wrapper. Cleaner intent, simpler implementation, no escape hatch needed.

### 3. `recovery.ts` passes tenant through `isArchived`

Each event yielded by `scanPending(backend)` already carries a `.tenant` field. The change is `isArchived(store, id, tenant)` — the caller already has the tenant in hand. Semantics are unchanged because ids are globally unique.

A one-line code comment in `recovery.ts` documents the assumption ("ids are globally unique; scoping by tenant is correctness-equivalent here") so a future reviewer can spot if that ever bends.

### 4. Flamegraph handler returns 200 + empty fragment when there is no active tenant

Three reachable cases for `/dashboard/invocations/:id/flamegraph`:

1. `!activeTenant` — user has no tenants in scope.
2. `activeTenant`, query returns 0 rows — id does not exist *in this tenant* (might or might not exist in another).
3. `activeTenant`, query returns rows — render the flamegraph.

Cases (1) and (2) MUST produce indistinguishable responses, otherwise an attacker with zero tenants can probe ids and learn whether they exist in *some* tenant — leak via response shape.

Choice: 200 + `flame-empty` fragment for both. `renderFlamegraph([])` already returns this safely. HTMX-friendly (fragment endpoints expect 200). Honest in case (1) ("nothing to show you"), honest in case (2) ("no events for you here"). 404 was rejected because HTMX swap behaviour is awkward and because case (1) is misleading-as-404.

### 5. Migration is a single change, not point-fix-then-refactor

Sequence (Order A):

1. Introduce `query(tenant)` and `ping()` on `EventStore`.
2. Migrate `dashboard/middleware.ts`, `recovery.ts`, `health.ts` to the new API. The flamegraph fix is one of these migrations.
3. Remove the old `query` field.
4. Add the cross-tenant regression test.

Bundling avoids a transient state where two patterns coexist in the same diff. Spec deltas land in the same change.

## Risks / Trade-offs

- [Recovery's id-uniqueness assumption is now load-bearing] → Document in code comment + recovery spec scenario. If we ever introduce non-globally-unique ids, the implementation must explicitly iterate tenants.
- [`ping()` doesn't exercise the same code path as `countAll`] → True but acceptable: a `SELECT 1` failure indicates DB unavailability just as well, and the existing rest of `checkEventstore` still wraps it in `timed()` and the standard error reporter.
- [Test stub rewrites — `health.test.ts` mocks `EventStore` as `{ query: { select: ... } }`; that shape is gone] → Stubs become `{ query: vi.fn(), ping: vi.fn() }`; mechanical.
- [Future cross-tenant admin views have no API for it] → Intentional. They must iterate tenants and aggregate explicitly. Adds a small amount of code at the (rare) cross-tenant call site in exchange for removing a sharp edge from the (common) per-tenant call sites.
- [The change packages a security fix with a refactor] → Yes; this is deliberate and was an explicit decision. The point fix alone leaves the bug class open. Bundling means the security guarantee lands atomically with the API that enforces it.

## Migration Plan

No data migration. No operator action. The change is a code-level refactor; on-disk format and HTTP surface are unchanged. Callers update with the compiler's help — `query` field → `query()` method is a hard error at every call site, which is the entire point.

Rollback: revert the change. No state to undo.

## Open Questions

None — the decisions above are settled by Threads 1–3 of the F2 explore session.
