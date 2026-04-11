## MODIFIED Requirements

### Requirement: Event list page
The system SHALL serve an HTML page at `GET /trigger/` listing all defined workflow events by name, rendered with authenticated user identity.

#### Scenario: Page lists all events with user identity
- **WHEN** a browser requests `GET /trigger/` with `X-Auth-Request-User: stefan` and `X-Auth-Request-Email: stefan@example.com` headers
- **THEN** the response is an HTML document rendered via the shared layout with user and email
- **THEN** each event from the JSON Schema map is listed as a `<details>` element with the event name as the `<summary>`

### Requirement: Form submission via fetch
The system SHALL provide a global `submitEvent` function in an external JavaScript file (`/static/trigger-forms.js`) that reads the Jedison form value and submits it via `fetch()`.

#### Scenario: Submit button triggers fetch call
- **WHEN** the user clicks the submit button for an event
- **THEN** `jedison.getValue()` is called on the cached instance
- **THEN** `fetch('POST', '/trigger/:eventType', ...)` is called with the JSON body
- **THEN** the response HTML fragment is swapped into the banner target area inside the `<details>` block

### Requirement: Lazy form initialization
The system SHALL provide a global `initForm` function in the external JavaScript file (`/static/trigger-forms.js`) that initializes a Jedison form instance when a `<details>` block is first expanded.

#### Scenario: First expansion creates form
- **WHEN** a `<details>` block is opened for the first time
- **THEN** the embedded JSON Schema is read from the `<script>` element
- **THEN** a Jedison instance is created targeting the form container inside that `<details>` block
- **THEN** the Jedison instance is cached on the DOM element

## REMOVED Requirements

### Requirement: Jedison static asset route
**Reason**: Jedison is now served by the static middleware at `/static/jedison.js` instead of by the trigger middleware at `/trigger/jedison.js`.
**Migration**: Update references from `/trigger/jedison.js` to `/static/jedison.js`.
