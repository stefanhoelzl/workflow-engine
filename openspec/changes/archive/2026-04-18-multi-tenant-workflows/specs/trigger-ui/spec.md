## ADDED Requirements

### Requirement: Trigger UI scopes to the active tenant

The trigger UI at `GET /trigger/` SHALL render the same active tenant selector as the dashboard (see `dashboard-list-view` "Active tenant selector scopes the dashboard"). The set of triggers listed on the page SHALL be filtered to those whose workflow's `tenant` equals the active tenant. Triggers belonging to other tenants SHALL NOT appear.

The active tenant SHALL be carried as the query param `?tenant=<tenant>` on the page shell. When absent, the runtime SHALL default to the first entry (alphabetical) in the user's tenant list (`UserContext.orgs ∪ {UserContext.name}`, regex-filtered).

Manual trigger submissions (`POST /trigger/:eventType`) SHALL only succeed if the trigger's owning workflow belongs to the caller's active (or any member) tenant; cross-tenant submissions SHALL be rejected with `404 Not Found`.

#### Scenario: Trigger list filtered by tenant

- **GIVEN** the runtime has triggers across tenants "acme" (2 triggers) and "stefan" (1 trigger)
- **GIVEN** a user whose tenant set is `{"acme", "stefan"}`, with active tenant `"acme"`
- **WHEN** the trigger page is rendered
- **THEN** the page SHALL list exactly the 2 triggers belonging to "acme"
- **AND** the "stefan" trigger SHALL NOT appear

#### Scenario: Switching active tenant updates list

- **GIVEN** the setup above, active tenant initially `"acme"`
- **WHEN** the user selects `"stefan"` in the selector
- **THEN** the browser SHALL navigate to `/trigger/?tenant=stefan`
- **AND** the page SHALL list only the "stefan" trigger

#### Scenario: Cross-tenant submission rejected

- **GIVEN** a user whose tenant set is `{"acme"}`, with active tenant `"acme"`
- **WHEN** the user (or a scripted client) posts to `POST /trigger/<eventType>` targeting a trigger whose workflow's tenant is `"contoso"`
- **THEN** the server SHALL respond with `404 Not Found`
- **AND** no event SHALL be emitted

#### Scenario: User with no tenants sees empty state

- **GIVEN** a user with an empty (regex-filtered) tenant set
- **WHEN** the trigger page is rendered
- **THEN** the page SHALL render the layout with an empty/disabled selector
- **AND** no triggers SHALL be listed
