## MODIFIED Requirements

### Requirement: Event list page

The system SHALL serve an HTML page at `GET /trigger/` listing every registered trigger across all workflows and tenants, rendered with authenticated user identity. Listing SHALL be kind-agnostic — every `TriggerDescriptor` regardless of `kind` SHALL appear. Each entry SHALL display a small icon representing the trigger's `kind` with the kind name as a hover tooltip.

#### Scenario: Page lists all triggers with user identity and kind icon

- **WHEN** a browser requests `GET /trigger/` with `X-Auth-Request-User: stefan` and `X-Auth-Request-Email: stefan@example.com` headers
- **THEN** the response is an HTML document rendered via the shared layout with user and email
- **THEN** each trigger from the workflow registry is listed as a `<details>` element with the trigger name as the `<summary>`
- **AND** each `<summary>` contains an icon element representing `descriptor.kind` with `descriptor.kind` as the hover tooltip (e.g., `title="http"`)

#### Scenario: JSON Schema embedded per trigger

- **WHEN** the page is rendered
- **THEN** each `<details>` block contains a `<script type="application/json">` element carrying the trigger's `inputSchema` serialized as JSON Schema
- **THEN** the schema has been processed by `prepareSchema` which promotes `example` values to `default` and labels `anyOf` variants with type titles

### Requirement: Event submission

The system SHALL accept `POST /trigger/<tenant>/<workflow>/<trigger-name>` with a JSON body and dispatch it through the kind's `TriggerSource` via the shared validator and executor. The response SHALL render the executor's output as a JSON block. On validation failure the response SHALL render the Zod issues as an error banner; on executor error the response SHALL render the error as an error banner.

#### Scenario: Successful submission

- **WHEN** a POST request is sent to `/trigger/<tenant>/<workflow>/submitForm` with a valid JSON payload matching the trigger's `inputSchema`
- **THEN** the shared validator validates the payload
- **AND** `executor.invoke(workflow, descriptor, input)` is called exactly once
- **THEN** the response is an HTML fragment containing a success banner and the executor's `output` rendered as pretty-printed JSON

#### Scenario: Validation failure

- **WHEN** a POST request is sent with a payload that fails `inputSchema` validation
- **THEN** the response is an HTML fragment containing an error banner with field-level validation messages from the Zod issues

#### Scenario: Unknown trigger

- **WHEN** a POST request is sent to `/trigger/<tenant>/<workflow>/nonexistent`
- **THEN** the response is an HTML fragment containing an error banner indicating no trigger was found

#### Scenario: Executor error

- **WHEN** a POST request is sent and the handler throws
- **THEN** `executor.invoke` returns `{ ok: false, error }`
- **AND** the response is an HTML fragment containing an error banner with the error message

## ADDED Requirements

### Requirement: Kind-agnostic form rendering

The trigger UI SHALL build the manual-fire form for every trigger from `descriptor.inputSchema` alone, without any per-kind rendering code path. The UI SHALL render every trigger's `output` identically as pretty-printed JSON in the success banner. Adding a new trigger kind SHALL NOT require changes to `trigger-ui`.

#### Scenario: Form rendered from inputSchema

- **GIVEN** a trigger descriptor of any `kind`
- **WHEN** the user expands its `<details>` block
- **THEN** the Jedison form SHALL be built from `descriptor.inputSchema` exactly as today
- **AND** submitting SHALL send the form value to `/trigger/<tenant>/<workflow>/<name>` as JSON

#### Scenario: Output rendered as JSON

- **GIVEN** a successful trigger submission with executor `output = { status: 202, body: { ok: true } }`
- **WHEN** the response HTML fragment renders
- **THEN** the fragment SHALL contain a `<pre>` block with the JSON-serialised output

#### Scenario: Kind icon mapping

- **WHEN** a descriptor with `kind: "http"` is listed
- **THEN** the row SHALL render an HTTP-representative icon (e.g., network/globe glyph) with `title="http"`
- **GIVEN** a future descriptor with `kind: "cron"`
- **THEN** the UI SHALL render a clock icon with `title="cron"` without any code change beyond a `kind → icon` entry in the mapping table
