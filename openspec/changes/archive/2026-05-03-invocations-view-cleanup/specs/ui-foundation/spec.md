## MODIFIED Requirements

### Requirement: Universal topbar

Every authenticated UI surface and every error page (404, 5xx) SHALL render the same topbar element. The topbar SHALL display the brand wordmark "Workflow Engine" coloured with the active accent token. User identity (username, email if available, and a sign-out control) SHALL render in the topbar if and only if the request resolved an authenticated session; otherwise the topbar SHALL render the wordmark alone.

The topbar SHALL NOT render different markup for different surface kinds. Surface-specific user-info suppression (forced-anonymous topbar on error pages) SHALL NOT exist; the topbar reads session state like any other page and degrades naturally when none is available.

The login page is explicitly exempt from this requirement. The login page is a self-contained auth card whose heading SHALL carry the brand wordmark "Workflow Engine" in the active accent token, replacing the topbar's branding role. The login page SHALL NOT render the topbar element.

#### Scenario: Authenticated surface shows user identity

- **GIVEN** a user with a valid session cookie
- **WHEN** any authenticated UI surface (e.g. `/invocations`, `/trigger`) is rendered
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL display the user's username and (if available) email address
- **AND** the topbar SHALL include a sign-out control

#### Scenario: Login page omits the topbar

- **WHEN** the login page is rendered
- **THEN** the response SHALL NOT contain the topbar element
- **AND** the auth card heading SHALL contain the brand wordmark "Workflow Engine"
- **AND** the brand wordmark SHALL be styled with the active accent token

#### Scenario: Anonymous error page shows wordmark only

- **WHEN** an error page (404 or 5xx) is rendered for a request without a valid session
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL NOT display any user identity

#### Scenario: Authenticated user hits an error page

- **GIVEN** a user with a valid session cookie
- **WHEN** they request a non-existent path and receive a 404
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL display the user's username (and email if available)

### Requirement: Cross-surface kind colour mapping

Top-level event prefixes (`trigger`, `action`, `system`) SHALL each have a distinct colour token used consistently across every surface that visualises kinds. The invocations list, the events log, the sidebar tree, and the flamegraph slices SHALL all derive kind colour from the same prefix-keyed palette. The runtime SHALL NOT use one palette for the invocations list and a different palette for the flamegraph.

#### Scenario: Invocations view and flamegraph use the same trigger colour

- **GIVEN** an invocation whose `trigger.request` is rendered both as a row in the invocations list and as a slice in the flamegraph
- **WHEN** both surfaces are rendered
- **THEN** the trigger-prefix colour applied to the row indicator SHALL match the colour applied to the flamegraph slice

#### Scenario: Adding a new event prefix requires a new colour

- **WHEN** a future change introduces a new top-level event prefix outside `trigger` / `action` / `system`
- **THEN** the change SHALL extend the prefix-keyed colour palette with a distinct entry
- **AND** every kind-rendering surface SHALL pick up the new colour automatically by reading from the same palette

### Requirement: Cross-surface status semantics

Invocation status SHALL use a single vocabulary across every surface that surfaces invocation state: `pending`, `running`, `succeeded`, `failed`. A `failed` invocation associated with a `system.exhaustion` event SHALL additionally surface an exhaustion dimension indicator (`cpu`, `memory`, `output`, or `pending`) alongside the failed status.

#### Scenario: Status vocabulary is consistent

- **WHEN** an invocation appears on the invocations list and (if expanded) in the flamegraph header
- **THEN** the status label rendered in both places SHALL be drawn from the same vocabulary set (`pending` / `running` / `succeeded` / `failed`)

#### Scenario: Exhaustion pill alongside failed status

- **GIVEN** a failed invocation associated with a `system.exhaustion` event whose `dim` is `cpu`
- **WHEN** the row is rendered
- **THEN** the row SHALL display the `failed` status indicator
- **AND** the row SHALL display an `exhaustion` indicator labelled `CPU` adjacent to the status

## ADDED Requirements

### Requirement: Upload kind icon registered in the trigger-kind registry

The cross-surface trigger-kind icon registry SHALL include an `upload` kind whose glyph is an upload-arrow shape and whose colour token is the active accent token (distinct from the `trigger` / `action` / `system` prefix palette). The `upload` kind is consumed by the invocations list to render the leading icon for synthetic `system.upload` rows.

The accent treatment SHALL be applied via a CSS rule selecting the `upload` variant of the trigger-kind icon container (e.g. `.trigger-kind-icon--upload`), so the colour follows the active theme's accent token rather than `currentColor` of the surrounding row.

#### Scenario: Synthetic upload row leading icon uses accent colour

- **GIVEN** an invocation row for a synthetic `system.upload` event
- **WHEN** the invocations list is rendered
- **THEN** the row's leading icon SHALL render the upload-arrow glyph
- **AND** the rendered icon's resolved colour SHALL be the active theme's accent colour (matching `var(--accent)`)
- **AND** the colour SHALL NOT match the `trigger` / `action` / `system` prefix palette

#### Scenario: Upload kind icon is registered alongside other kinds

- **WHEN** the trigger-kind registry is consulted for the kind string `"upload"`
- **THEN** the registry SHALL return a glyph component
- **AND** the glyph SHALL render as inline SVG following the icon-rendering invariants
