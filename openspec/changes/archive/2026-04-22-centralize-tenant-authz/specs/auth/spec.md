## ADDED Requirements

### Requirement: Tenant-authorization middleware

The runtime SHALL expose a `requireTenantMember()` Hono middleware factory in the `auth` capability. The middleware SHALL enforce the tenant-isolation invariant (SECURITY.md §4) for any route that accepts a `:tenant` path parameter, returning `404 Not Found` fail-closed on any failure mode (invalid identifier, non-member, or missing user outside open mode).

Evaluation order inside the middleware:

1. Read `c.req.param("tenant")`. If the value does not satisfy `validateTenant` (regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`), respond with `c.notFound()`. This check SHALL run before the open-mode bypass, because the regex is a path-safety guarantee, not an authorization check.
2. If `c.get("authOpen") === true`, call `next()` (open-mode dev bypass, per the existing "Bearer middleware on /api/\*" requirement).
3. If `user = c.get("user")` is set and `isMember(user, tenant)` returns true, call `next()`.
4. Otherwise, respond with `c.notFound()`.

The middleware SHALL NOT hardcode a response body. Each Hono sub-app that mounts the middleware SHALL register an `app.notFound(c => c.json({error:"Not Found"}, 404))` handler so that 404 responses carry a uniform JSON body across `/api/*` and `/trigger/*`.

The middleware SHALL read only the path parameter named `tenant`. It SHALL NOT accept configuration for a different parameter name or a custom accessor — all tenant-scoped routes SHALL use the path parameter name `tenant`.

The following routes SHALL enforce tenant membership by mounting `requireTenantMember()` and SHALL NOT perform the `validateTenant` + `isMember` check inline in their handlers:

- `POST /api/workflows/:tenant` (mounted in `api/index.ts`).
- `POST /trigger/:tenant/:workflow/:trigger` (mounted in `ui/trigger/middleware.ts` on the `/trigger`-basePath sub-app at `/:tenant/*`).

Any future route that accepts a `:tenant` path parameter SHALL mount `requireTenantMember()` on the corresponding subpath. Inline tenant-authorization checks in individual route handlers SHALL be treated as a defect.

#### Scenario: Invalid tenant identifier returns 404

- **GIVEN** `requireTenantMember()` is mounted on `/workflows/:tenant` in the `/api` sub-app
- **WHEN** a request arrives at `POST /api/workflows/../etc/passwd`
- **THEN** the middleware SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the handler SHALL NOT be invoked
- **AND** the response SHALL be indistinguishable from the response for a non-existent tenant

#### Scenario: Non-member returns 404

- **GIVEN** `auth.mode === "restricted"` and `user = { name: "alice", mail: "", orgs: ["acme"] }`
- **WHEN** a request to `POST /api/workflows/victim` presents credentials that resolve to `alice`, who is not a member of `victim`
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the response SHALL be indistinguishable from the response for a tenant that does not exist

#### Scenario: Member passes to handler

- **GIVEN** `auth.mode === "restricted"` and `user = { name: "alice", mail: "", orgs: ["acme"] }`
- **WHEN** a request to `POST /api/workflows/acme` presents credentials that resolve to `alice`
- **THEN** `requireTenantMember()` SHALL call `next()` without modifying the response
- **AND** the upload handler SHALL receive the request

#### Scenario: Open-mode bypass via authOpen flag

- **GIVEN** `auth.mode === "open"` and `c.get("authOpen") === true`
- **WHEN** a request to `POST /api/workflows/anything-valid` arrives without a `user` on the context
- **THEN** `requireTenantMember()` SHALL call `next()` without evaluating `isMember`
- **AND** the handler SHALL receive the request

#### Scenario: Open mode does not relax identifier validation

- **GIVEN** `auth.mode === "open"` and `c.get("authOpen") === true`
- **WHEN** a request to `POST /api/workflows/../traversal` arrives
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the handler SHALL NOT be invoked

#### Scenario: Missing user outside open mode returns 404

- **GIVEN** `auth.mode === "restricted"` and `c.get("authOpen")` is unset
- **WHEN** a request to `POST /api/workflows/acme` arrives with no `user` on the context (e.g., authn middleware failed to populate it)
- **THEN** `requireTenantMember()` SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the middleware SHALL NOT fall through to the handler

#### Scenario: Trigger POST uses same middleware

- **GIVEN** `requireTenantMember()` is mounted on `/:tenant/*` of the `/trigger`-basePath sub-app
- **AND** `auth.mode === "restricted"` and `user = { name: "alice", mail: "", orgs: [] }`
- **WHEN** a request to `POST /trigger/victim/wf/tr` arrives from `alice`
- **THEN** the middleware SHALL respond with `404 Not Found` and body `{"error":"Not Found"}`
- **AND** the POST handler SHALL NOT be invoked
- **AND** no inline `validateTenant` or `tenantSet(user).has(tenant)` check SHALL remain in the POST handler
