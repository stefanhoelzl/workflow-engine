## ADDED Requirements

### Requirement: Tenant identifier format

A tenant identifier SHALL be a non-empty string matching the regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$` (1–63 characters; first character alphanumeric; subsequent characters alphanumeric, hyphen, or underscore). The runtime SHALL reject any request whose `<tenant>` path parameter fails this regex with `404 Not Found`.

The same regex SHALL be applied when deriving the set of tenants a user belongs to from `UserContext.orgs` and `UserContext.name`: entries that fail the regex SHALL be silently filtered out of the tenant set (they are not usable as tenants, even if the IdP produced them).

#### Scenario: Valid tenant accepted

- **WHEN** a request presents `<tenant>` = `"acme"` or `"stefan-hoelzl"` or `"team_42"`
- **THEN** the regex SHALL match
- **AND** the request SHALL proceed to membership validation

#### Scenario: Path traversal rejected

- **WHEN** a request presents `<tenant>` = `".."`, `"foo/bar"`, `"..%2F"`, `""`, or `"-foo"`
- **THEN** the regex SHALL NOT match
- **AND** the request SHALL receive `404 Not Found`

#### Scenario: Over-long tenant rejected

- **WHEN** a request presents `<tenant>` of length 64 or more
- **THEN** the regex SHALL NOT match
- **AND** the request SHALL receive `404 Not Found`

#### Scenario: IdP group with invalid chars filtered out of user's tenant set

- **GIVEN** `UserContext.orgs = ["acme", "bad:group", "..", "contoso"]`
- **WHEN** the tenant set is computed
- **THEN** the set SHALL contain only `"acme"` and `"contoso"`
- **AND** entries `"bad:group"` and `".."` SHALL be silently excluded

### Requirement: Tenant membership predicate

A user SHALL be considered a member of tenant `t` if and only if `UserContext.orgs.includes(t) || UserContext.name === t` (after applying the valid-tenant filter above). No other predicate SHALL grant access to a tenant's resources.

`UserContext.teams` SHALL NOT be consulted for tenant membership; teams are a separate dimension preserved for future use and are ignored by this capability.

#### Scenario: User is a member of a real org

- **GIVEN** `UserContext.name = "alice"`, `UserContext.orgs = ["acme", "contoso"]`
- **WHEN** the membership predicate is evaluated for tenant `"acme"`
- **THEN** it SHALL return `true`

#### Scenario: User is the pseudo-tenant equal to their login

- **GIVEN** `UserContext.name = "alice"`, `UserContext.orgs = []`
- **WHEN** the membership predicate is evaluated for tenant `"alice"`
- **THEN** it SHALL return `true`

#### Scenario: User is not a member

- **GIVEN** `UserContext.name = "alice"`, `UserContext.orgs = ["acme"]`
- **WHEN** the membership predicate is evaluated for tenant `"contoso"`
- **THEN** it SHALL return `false`

#### Scenario: Teams do not grant membership

- **GIVEN** `UserContext.name = "alice"`, `UserContext.orgs = []`, `UserContext.teams = ["acme:platform"]`
- **WHEN** the membership predicate is evaluated for tenant `"acme"`
- **THEN** it SHALL return `false`
- **AND** membership is NOT granted via team inheritance

### Requirement: User–org namespace disjointness

The runtime SHALL operate under the invariant that a given identifier cannot simultaneously be both a user login AND a real organization name for members of the same `UserContext`. Violating this invariant is operator misconfiguration of the identity provider. The runtime SHALL NOT attempt to disambiguate; the membership predicate's `||` composition resolves to `true` for either interpretation.

For GitHub OAuth this invariant is enforced by GitHub itself (user logins and org names share a single namespace). For other OIDC / oauth2-proxy providers, operators SHALL configure groups and user identifiers from disjoint namespaces.

#### Scenario: GitHub namespace disjointness

- **GIVEN** an IdP that is GitHub
- **THEN** the invariant SHALL hold by construction
- **AND** no runtime disambiguation SHALL be required

#### Scenario: Operator responsibility

- **GIVEN** a non-GitHub IdP where a group name might collide with a user login
- **THEN** the operator SHALL configure the IdP to prevent such collisions
- **AND** the runtime SHALL NOT attempt to detect or warn about collisions
