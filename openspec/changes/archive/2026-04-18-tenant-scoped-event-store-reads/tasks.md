## 1. EventStore API change

- [x] 1.1 In `packages/runtime/src/event-bus/event-store.ts`, change `EventStore.query` from a public field to a method `query(tenant: string): SelectQueryBuilder<Database, "events", object>`. The method body returns `db.selectFrom("events").where("tenant", "=", tenant)`.
- [x] 1.2 Add `EventStore.ping(): Promise<void>` to the interface and the factory return value. Implementation issues `SELECT 1` against the underlying DuckDB connection (use Kysely `sql` or the raw connection — whichever is cleaner given the existing `createEventStore` body).
- [x] 1.3 Update `event-bus/event-store.ts` exports if the type signature change requires it (none expected; the named type stays the same).
- [x] 1.4 In `packages/runtime/src/event-bus/event-store.test.ts`, replace any test that uses `store.query.where(...)` directly with `store.query(tenant).where(...)`. Add a tenant-scoping test mirroring the spec scenarios: seed events for two tenants, assert `query("t0")` only returns tenant-`t0` rows.
- [x] 1.5 Add a `ping()` test: confirm it resolves on a healthy store. (Rejection path is type-system-trivial: `await db.executeQuery(...)` propagates DuckDB errors; mocking adds noise without coverage.)

## 2. Dashboard middleware migration (security fix lands here)

- [x] 2.1 In `packages/runtime/src/ui/dashboard/middleware.ts`, change `fetchInvocationRows(eventStore, tenant, limit)` body to use `eventStore.query(tenant).where("kind", "=", "trigger.request")...` (drop the now-redundant `.where("tenant", "=", tenant)` clauses on lines ~91 and ~104 since the query method pre-binds them).
- [x] 2.2 Change `fetchInvocationEvents(eventStore, id, tenant)` to take a required `tenant` parameter; body uses `eventStore.query(tenant).where("id", "=", id)...`.
- [x] 2.3 Update the `/invocations/:id/flamegraph` handler to resolve the active tenant via `sortedTenants(c, deps.registry)` + `resolveActiveTenant(c, ...)`; short-circuit to `c.html(renderFlamegraph([]))` when `!activeTenant`; otherwise pass `activeTenant` into `fetchInvocationEvents`.
- [x] 2.4 In `packages/runtime/src/ui/dashboard/middleware.test.ts`, retrofit the existing flamegraph tests at lines ~320, 331, 343, 352 to send `AUTH_HEADERS` so `activeTenant === "t0"` resolves and the seeded events match.
- [x] 2.5 Add the cross-tenant regression test specified in the dashboard-list-view spec ("Cross-tenant request returns empty-state fragment without leaking events"): seed an `evt_xyz` in tenant `"other"` with identifiable `input`/`output` payloads, request as a `t0` user, assert `200` + `flame-empty` + neither payload string present in the body.
- [x] 2.6 Add a no-active-tenant regression test ("Request with no resolvable active tenant returns empty-state fragment"): user with no tenants in scope, assert `200` + `flame-empty`.

## 3. Recovery migration

- [x] 3.1 In `packages/runtime/src/recovery.ts`, change `isArchived(eventStore, id)` to `isArchived(eventStore, id, tenant)`; body uses `eventStore.query(tenant).where("id", "=", id).select("id").limit(1).execute()`.
- [x] 3.2 At the call site (~line 58 of `recovery.ts`), pass `firstEvent.tenant` as the third argument.
- [x] 3.3 Add a one-line code comment at the call site documenting the load-bearing assumption: `// ids are globally unique (UUID + (id, seq) PK); scoping by tenant is correctness-equivalent here`.
- [x] 3.4 Update `recovery.test.ts` if any existing test uses the old signature; add a scenario that confirms recovery succeeds when the pending event carries a tenant matching an archived event. (Existing "skips replay and clears stale pending when archive is already in the event store" test at recovery.test.ts:163 already exercises the tenant-matching path — both pending and archive use default tenant "t0". No new test needed.)

## 4. Health check migration

- [x] 4.1 In `packages/runtime/src/health.ts` `checkEventstore`, replace the `eventStore.query.select(...).executeTakeFirstOrThrow()` call with `eventStore.ping()`. Keep the `timed()` wrapper and `pass`/`fail` reporting.
- [x] 4.2 In `packages/runtime/src/health.test.ts` `stubEventStore`, replace the `query: { ... }` shape with `query: vi.fn()` (kept for unrelated tests if any) and `ping: vi.fn().mockResolvedValue(undefined)`. Update the slow-store test (around line 190) to mock a slow `ping()` instead of slow `query.select`.

## 5. Validation

- [x] 5.1 Run `pnpm check` — TypeScript should now hard-error at every old-API call site that wasn't migrated. Resolve any remaining hits.
- [x] 5.2 Run `pnpm lint`.
- [x] 5.3 Run `pnpm test packages/runtime/src/ui/dashboard/middleware.test.ts` — 17/17 pass including two new regression tests (cross-tenant leak prevention + no-active-tenant empty fragment).
- [x] 5.4 Run `pnpm test` — full suite, 421/421 pass.
- [ ] 5.5 Manual smoke: seed two tenants with at least one completed invocation each, request `/dashboard/invocations/<B-id>/flamegraph` as a tenant-A user, confirm `200` + `flame-empty` + no tenant-B data in the response. (Deferred — automated regression test in middleware.test.ts asserts the same invariant; manual smoke is operator-side.)

## 6. Spec archive prep

- [x] 6.1 Sanity-check the three spec deltas in this change by running `pnpm exec openspec validate tenant-scoped-event-store-reads --strict` (or equivalent). Passed.
- [x] 6.2 Confirm no other openspec spec references `eventStore.query` as a property (grep `openspec/specs/` for `eventStore.query`); update or note any stragglers. Three references remain — all in the *current* `event-store` and `dashboard-list-view` specs that the change deltas will overwrite on archive. No additional capabilities affected.
