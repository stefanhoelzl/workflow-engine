## ADDED Requirements

### Requirement: Active tenant selector scopes the dashboard

The dashboard SHALL render an active tenant selector at the top of the page. The selector SHALL present the tenants the user belongs to — computed as `UserContext.orgs ∪ {UserContext.name}`, filtered through the tenant-identifier regex (see `tenant-model`).

Exactly one tenant SHALL be "active" at any time. All invocation queries SHALL be scoped to the active tenant by applying `WHERE tenant = ?` to the EventStore query (see `event-store` "Query latest invocations").

The active tenant SHALL be carried in the request URL as a query parameter `?tenant=<tenant>` (on the page shell and on the deferred data endpoint). When the query param is absent, the runtime SHALL default to the first entry in the user's tenant list (alphabetical order of `orgs ∪ {name}`), rendering the selector with that value pre-selected and redirecting the user to the canonical URL with the query param set.

Invocations belonging to tenants the user is not a member of SHALL NEVER be visible via the dashboard, regardless of URL manipulation.

#### Scenario: Selector lists all of a user's tenants

- **GIVEN** a user with `UserContext.name = "stefan-hoelzl"`, `UserContext.orgs = ["acme", "contoso"]`
- **WHEN** the dashboard is rendered
- **THEN** the selector SHALL offer three options: `"acme"`, `"contoso"`, `"stefan-hoelzl"` (order: alphabetical)
- **AND** exactly one SHALL be selected

#### Scenario: Default tenant when no query param

- **GIVEN** a user with `UserContext.name = "stefan-hoelzl"`, `UserContext.orgs = ["acme"]`
- **WHEN** the dashboard is requested with no `?tenant=` query param
- **THEN** the response SHALL redirect (or render) with `?tenant=acme` (first alphabetically)

#### Scenario: Explicit tenant query param

- **GIVEN** the same user as above
- **WHEN** the dashboard is requested with `?tenant=stefan-hoelzl`
- **THEN** the selector SHALL show `stefan-hoelzl` as active
- **AND** the invocation list SHALL contain only invocations whose `tenant` column equals `"stefan-hoelzl"`

#### Scenario: User attempts to view a tenant they are not a member of

- **GIVEN** a user with `UserContext.orgs = ["acme"]`, `UserContext.name = "alice"`
- **WHEN** the dashboard is requested with `?tenant=contoso`
- **THEN** the response SHALL behave as if the user's default tenant had been requested (redirect to the first tenant the user IS a member of)
- **AND** no "contoso" invocation data SHALL be served

#### Scenario: User with no tenants

- **GIVEN** a user whose `UserContext.orgs = []` and whose `UserContext.name` fails the tenant-identifier regex
- **WHEN** the dashboard is rendered
- **THEN** the selector SHALL be present but empty/disabled
- **AND** the invocation list SHALL show the empty-state message
- **AND** the page SHALL render without a server error

#### Scenario: Selector change triggers navigation

- **WHEN** the user selects a different tenant from the selector
- **THEN** the browser SHALL navigate to the dashboard URL with the new `?tenant=<value>` query param
- **AND** the page SHALL re-render scoped to the new tenant
