## MODIFIED Requirements

### Requirement: Flamegraph fragment endpoint

The runtime SHALL expose `GET /dashboard/invocations/:id/flamegraph` under the `/dashboard` path prefix. The endpoint SHALL resolve the active tenant from the request the same way the `/dashboard/invocations` list endpoint does (intersection of the user's groups with the workflow registry, defaulting to the first sorted entry; honouring `?tenant=` when the requested value is in the user's set). The endpoint SHALL read the invocation's events via `eventStore.query(activeTenant).where('id', '=', id).orderBy('seq', 'asc').execute()` and return an HTML fragment (not a full page shell).

The response status SHALL be `200` for every reachable case. The empty-state fragment SHALL be returned when:

- the request resolves no active tenant (user has no tenants in scope), OR
- the active-tenant query returns zero rows for the requested id (id does not exist in the active tenant — including the case where it exists in a tenant the user is not a member of).

These two cases SHALL be indistinguishable to the caller (identical response body and status), so that an attacker cannot enumerate cross-tenant ids by probing the endpoint.

The endpoint SHALL NOT validate the id string against any format regex; it SHALL pass the raw path parameter to the parameterized DuckDB query.

#### Scenario: Completed invocation in the active tenant returns a flamegraph SVG fragment

- **GIVEN** `evt_abc` has a full event stream terminating in `trigger.response`, owned by tenant `"t0"`
- **AND** the requesting user is a member of tenant `"t0"`
- **WHEN** `GET /dashboard/invocations/evt_abc/flamegraph` is called
- **THEN** the response SHALL be `200` and its body SHALL be an HTML fragment containing an `<svg>` element

#### Scenario: Unknown id returns empty-state fragment with 200

- **GIVEN** no events exist in the EventStore for id `evt_missing` in any tenant
- **AND** the requesting user is a member of tenant `"t0"`
- **WHEN** `GET /dashboard/invocations/evt_missing/flamegraph` is called
- **THEN** the response SHALL be `200` and its body SHALL contain the empty-state fragment with user-visible text indicating no flamegraph is available
- **AND** the body SHALL NOT contain an `<svg>` element

#### Scenario: Pending invocation in the active tenant returns empty-state fragment

- **GIVEN** `evt_ghi` has a `trigger.request` event but no `trigger.response` or `trigger.error`, owned by tenant `"t0"`
- **AND** the requesting user is a member of tenant `"t0"`
- **WHEN** `GET /dashboard/invocations/evt_ghi/flamegraph` is called
- **THEN** the response SHALL be `200` and its body SHALL contain the empty-state fragment

#### Scenario: Cross-tenant request returns empty-state fragment without leaking events

- **GIVEN** `evt_xyz` has a full event stream owned by tenant `"other"` whose `input` and `output` payloads contain identifiable content
- **AND** the requesting user is a member of tenant `"t0"` and NOT a member of `"other"`
- **WHEN** `GET /dashboard/invocations/evt_xyz/flamegraph` is called (with no `?tenant=` override or with `?tenant=t0`)
- **THEN** the response SHALL be `200` and its body SHALL contain the empty-state fragment
- **AND** the response body SHALL NOT contain any `<svg>` element
- **AND** the response body SHALL NOT contain any byte-string from the `input` or `output` payloads of `evt_xyz`

#### Scenario: Request with no resolvable active tenant returns empty-state fragment

- **GIVEN** the requesting user has no tenants in scope (groups intersect the registry as empty)
- **WHEN** `GET /dashboard/invocations/evt_anything/flamegraph` is called
- **THEN** the response SHALL be `200` and its body SHALL contain the empty-state fragment
- **AND** the response SHALL be byte-identical (modulo the requested id, which is not echoed in the body) to the response a user with an active tenant would receive when the id is not found in their tenant
