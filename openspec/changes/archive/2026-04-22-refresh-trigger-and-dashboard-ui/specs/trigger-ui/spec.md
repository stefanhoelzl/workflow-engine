## ADDED Requirements

### Requirement: Triggers grouped by workflow

The `/trigger` listing page SHALL present registered triggers grouped under per-workflow section headings. Workflow groups SHALL be ordered alphabetically by workflow name; triggers within each group SHALL be ordered alphabetically by trigger name. Each trigger card's summary SHALL show only the trigger name (not the workflow name, which is conveyed by the enclosing section). The per-trigger meta line (for HTTP: method + webhook URL; for cron: schedule + timezone) SHALL be rendered in monospace type, visually distinguished from the trigger name (e.g. right-aligned within the summary or rendered as a muted caption).

#### Scenario: Two workflows each with two triggers render as two groups

- **GIVEN** a tenant with workflows `workflow-a` (triggers `alpha`, `beta`) and `workflow-b` (triggers `gamma`, `delta`)
- **WHEN** a user loads `GET /trigger/<tenant>/`
- **THEN** the page SHALL contain two workflow section elements, in the order `workflow-a` then `workflow-b`
- **AND** the `workflow-a` section SHALL contain trigger cards in the order `alpha` then `beta`
- **AND** the `workflow-b` section SHALL contain trigger cards in the order `delta` then `gamma`

#### Scenario: Card summary omits the workflow name

- **GIVEN** a trigger `alpha` belonging to workflow `workflow-a`
- **WHEN** the page is rendered
- **THEN** the trigger card's summary text SHALL contain `alpha`
- **AND** the summary text SHALL NOT contain the substring `workflow-a /` as a prefix to the trigger name

#### Scenario: Meta line is visually distinguished from the trigger name

- **WHEN** any trigger card is rendered
- **THEN** the meta line (webhook URL + method for HTTP, schedule + tz for cron) SHALL be marked with a CSS class that selects monospace type
- **AND** the meta line SHALL be visually distinguished from the trigger name (right-alignment within the summary, or a separate muted caption line)

### Requirement: Dialog reflects trigger-fire outcome visually

The trigger-fire result dialog SHALL distinguish three outcome categories determined solely by the HTTP response status class returned by the dispatch endpoint: success (status `2xx`), client error (status `4xx`), and server error (status `5xx` or an unresolved fetch rejection). Each category SHALL apply a distinct visual treatment (colour, border, banner text) so that the outcome is readable without inspecting the response body. The contract SHALL be kind-agnostic: a trigger backend that honours the status-class invariant SHALL receive the corresponding visual treatment automatically.

The dialog SHALL remove any prior outcome class before applying a new one, so that re-opening the dialog for a subsequent fire does not composite visual states.

The dialog SHALL render a status banner containing, at minimum, the outcome word (e.g. "Success", "Failed", "Error"). When the response body is a JSON object with a top-level `error` field of string type, the banner SHALL also include that string. The numeric HTTP status code is NOT rendered in the banner — the response body below the banner already surfaces it, and the dialog's visual state carries the status class.

#### Scenario: 2xx response applies the success visual state

- **GIVEN** a trigger-fire POST that returns HTTP `200` with body `{"ok": true, "output": {...}}`
- **WHEN** the client-side dialog is shown
- **THEN** the dialog element SHALL carry the success visual class
- **AND** the dialog SHALL NOT carry the warn or error visual classes
- **AND** the banner SHALL contain the outcome word for success

#### Scenario: 4xx response applies the warn visual state

- **GIVEN** a trigger-fire POST that returns HTTP `422` with body `{"error": "payload_validation_failed", "issues": [...]}`
- **WHEN** the client-side dialog is shown
- **THEN** the dialog element SHALL carry the warn visual class
- **AND** the dialog SHALL NOT carry the success or error visual classes
- **AND** the banner SHALL contain the outcome word for a client error and the string `payload_validation_failed`

#### Scenario: 5xx response applies the error visual state

- **GIVEN** a trigger-fire POST that returns HTTP `500` with body `{"error": "internal_error", "details": {...}}`
- **WHEN** the client-side dialog is shown
- **THEN** the dialog element SHALL carry the error visual class
- **AND** the dialog SHALL NOT carry the success or warn visual classes
- **AND** the banner SHALL contain the outcome word for a server error and the string `internal_error`

#### Scenario: Network failure is treated as a server error

- **GIVEN** a trigger-fire `fetch()` that rejects before any response is received
- **WHEN** the client-side dialog is shown
- **THEN** the dialog element SHALL carry the error visual class
- **AND** the banner SHALL contain an outcome word for a server error

### Requirement: Submit control shows an in-flight loading state

While a trigger-fire request is in flight, the Submit control SHALL be visually distinguished as loading: the control SHALL be disabled against further clicks, and SHALL carry a CSS class that marks it as loading (e.g. surfacing a spinner glyph). The loading visual SHALL be cleared when the result dialog opens (success or failure path).

#### Scenario: In-flight submit is disabled and marked loading

- **GIVEN** the user has clicked Submit on a trigger card
- **WHEN** the fetch is in flight and the response has not yet arrived
- **THEN** the Submit control SHALL be disabled
- **AND** the Submit control SHALL carry a CSS class that marks it as loading

#### Scenario: Loading state is cleared when the dialog opens

- **GIVEN** a Submit that was marked loading at the start of a fire
- **WHEN** the result dialog is opened (for either a success or a failure outcome)
- **THEN** the Submit control's loading class SHALL be removed
- **AND** the Submit control SHALL no longer be disabled

## MODIFIED Requirements

### Requirement: Lazy form initialization
The system SHALL provide a client-side `initForm` procedure in the external JavaScript file (`/static/trigger-forms.js`) that initializes a Jedison form instance when a `<details>` block is first expanded. When the server-rendered trigger card carries no form container (because the trigger's input schema has no `properties` and no `additionalProperties`), no Jedison instance SHALL be created and the card SHALL present only the Submit control.

#### Scenario: First expansion creates form
- **WHEN** a `<details>` block containing a form container is opened for the first time
- **THEN** the embedded JSON Schema is read from the `<script>` element
- **THEN** a Jedison instance is created targeting the form container inside that `<details>` block
- **THEN** the Jedison instance is cached on the DOM element

#### Scenario: Subsequent toggles reuse instance
- **WHEN** a `<details>` block is collapsed and re-opened
- **THEN** no new Jedison instance is created
- **THEN** the previously entered form data is preserved

#### Scenario: Trigger with no user-settable inputs renders no form
- **GIVEN** a trigger whose input schema has neither `properties` nor `additionalProperties`
- **WHEN** the trigger card is rendered on the server
- **THEN** the card's body SHALL NOT contain a form container element
- **AND** when its `<details>` block is opened, no Jedison instance SHALL be created for that card
- **AND** the Submit control SHALL be the only interactive element visible inside the card body

### Requirement: Event submission
The system SHALL accept `POST /trigger/<tenant>/<workflow>/<trigger>` with a JSON body and dispatch the trigger via the shared executor, returning a kind-agnostic JSON envelope that distinguishes success, validation failure, and infrastructure failure by HTTP status class. The response body SHALL be JSON for every outcome (success and failure), enabling a kind-agnostic client-side dialog to key its visual treatment on status class alone.

#### Scenario: Successful submission
- **WHEN** a POST request is sent to `/trigger/<tenant>/<workflow>/<trigger>` with a payload that validates against the trigger's `inputSchema`
- **THEN** the server SHALL invoke the executor for that trigger with the parsed payload
- **AND** the response SHALL have status `2xx` with a JSON body containing `{"ok": true, "output": <executor output>}`

#### Scenario: Payload validation failure
- **WHEN** a POST request is sent with a payload that fails the trigger's `inputSchema` (or with a non-JSON body)
- **THEN** the response SHALL have status `4xx` (specifically `422` for a schema validation failure) with a JSON body containing a top-level `error` field
- **AND** the body MAY include an `issues` array describing field-level violations

#### Scenario: Infrastructure failure
- **WHEN** the executor throws or returns a non-validation failure for a POST request
- **THEN** the response SHALL have status `5xx` (specifically `500` for internal errors) with a JSON body containing a top-level `error` field
- **AND** the body MAY include a `details` object describing the failure

#### Scenario: Unknown trigger
- **WHEN** a POST request is sent to `/trigger/<tenant>/<workflow>/<trigger>` where no such trigger is registered for the given tenant + workflow
- **THEN** the response SHALL have status `404`
- **AND** the response SHALL NOT reveal whether the tenant or the workflow exists

### Requirement: Form submission via fetch
The system SHALL provide a client-side submit procedure in `/static/trigger-forms.js` that reads the Jedison form value (or an empty object for cards without a form), posts it as JSON to the trigger's dispatch URL, and hands the response to the shared result dialog for visual presentation.

#### Scenario: Submit posts the form value as JSON
- **WHEN** the user clicks the Submit button for a trigger with a form
- **THEN** `jedison.getValue()` SHALL be called on the cached instance
- **AND** the client SHALL POST the resulting JSON to the dispatch URL resolved from the trigger card

#### Scenario: Submit on a formless card posts an empty object
- **WHEN** the user clicks the Submit button for a trigger whose card has no form container
- **THEN** the client SHALL POST the JSON body `{}` to the dispatch URL resolved from the trigger card

#### Scenario: Response is handed to the result dialog
- **WHEN** the server responds to the submit request (with any HTTP status)
- **THEN** the client SHALL read the response body
- **AND** SHALL open the shared result dialog, passing the response status and parsed body to the dialog's `showResult` entry point for outcome-class selection

#### Scenario: Network rejection is handed to the result dialog
- **WHEN** the client-side `fetch()` rejects before receiving a response
- **THEN** the client SHALL open the shared result dialog in the server-error visual state with a human-readable banner indicating network failure

## REMOVED Requirements

### Requirement: Run now button for cron triggers
**Reason**: The "Run now" control was a cron-specific affordance that is now generalised. With the empty-form-hiding rule added to `Lazy form initialization`, any trigger whose input schema has no user-settable fields (cron is one such case; a body-less HTTP trigger is another) renders a bare Submit button, which is functionally equivalent to "Run now". The generalised Submit also participates in the three-state dialog and the in-flight loading state, whereas the prior "Run now" wording did not.
**Migration**: No code-side migration. The Submit button on any trigger card whose schema has no `properties` and no `additionalProperties` now serves the "fire with empty payload" role. The invariants the prior requirement enforced — exactly one `executor.invoke(..., {}, ...)` per click, scheduled cron timers untouched — are covered by the updated `Event submission` and `Form submission via fetch` requirements in conjunction with the runtime's cron-trigger backend. Existing cron trigger cards continue to function without change.
