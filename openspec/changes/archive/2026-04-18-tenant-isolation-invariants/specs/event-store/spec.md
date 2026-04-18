## ADDED Requirements

### Requirement: Security context

The implementation SHALL conform to the tenant isolation invariant
documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2).
The `EventStore.query(tenant)` API is the load-bearing enforcement point
for I-T2 on invocation-event reads: the required `tenant` argument is
pre-bound into a `.where("tenant", "=", tenant)` clause on the returned
Kysely `SelectQueryBuilder`, and no unscoped read API is exposed. This
makes tenant-scope omission structurally impossible — a caller cannot
construct a read against the `events` table without supplying a tenant
at the call site.

Changes to this capability that introduce a new read path against the
`events` table (including new public methods on `EventStore`, new
utilities that accept a `Kysely` instance, or re-exports that would
allow a consumer to build a query bypassing `query(tenant)`), or that
weaken the pre-binding behaviour of `query(tenant)`, MUST update
`/SECURITY.md §1` in the same change proposal.

#### Scenario: Change introduces a new read path

- **GIVEN** a change proposal that adds a new method, re-export, or
  utility that allows consumers to read from the `events` table
- **WHEN** the change is proposed
- **THEN** the proposal SHALL demonstrate that the new read path is
  tenant-scoped at its API surface (the `tenant` argument is required
  and the scope cannot be removed by the caller)
- **AND** the proposal SHALL update `/SECURITY.md §1 "Tenant isolation
  invariants"` to reference the new read path

#### Scenario: Change is orthogonal to the invariant

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not introduce a new read path and does not
  alter the `query(tenant)` pre-binding
- **THEN** no update to `/SECURITY.md §1` is required
- **AND** the proposal SHALL note that tenant-isolation alignment was
  checked
