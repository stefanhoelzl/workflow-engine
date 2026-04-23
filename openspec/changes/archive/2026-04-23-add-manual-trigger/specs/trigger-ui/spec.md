# Trigger UI Delta

## ADDED Requirements

### Requirement: Manual triggers listed alongside HTTP and cron triggers

The `/trigger` UI SHALL list manual triggers in the same list as HTTP and cron triggers, scoped to the active tenant. Each manual trigger entry SHALL display at least the trigger name and a manual-kind icon. The entry SHALL render a Jedison form derived from `descriptor.inputSchema`. When the schema has no fields, the form SHALL render as a bare Submit button (the same behaviour produced by any trigger whose input schema is `z.object({})`).

#### Scenario: Manual trigger appears in the list

- **GIVEN** a tenant with a loaded workflow containing `export const rerun = manualTrigger({ handler })`
- **WHEN** a user loads `GET /trigger?tenant=<t>`
- **THEN** the page SHALL list a trigger entry for `rerun`
- **AND** the entry SHALL display the manual-kind icon

#### Scenario: Manual trigger entry renders a schema-driven form

- **GIVEN** a manual trigger declared with `input: z.object({ id: z.string() })`
- **WHEN** the trigger card is expanded in the UI
- **THEN** Jedison SHALL render a form derived from the JSON Schema of the input
- **AND** the form SHALL include a string input for `id`

#### Scenario: Manual trigger with empty input renders a bare Submit button

- **GIVEN** a manual trigger declared with no `input` (default `z.object({})`)
- **WHEN** the trigger card is expanded in the UI
- **THEN** Jedison SHALL render a zero-field form
- **AND** the Submit button SHALL remain the only interactive element

### Requirement: Manual trigger submit posts to the kind-agnostic endpoint

When the user submits a manual-trigger card, the UI SHALL POST the Jedison form value (or `{}` for empty schemas) to `/trigger/<tenant>/<workflow>/<trigger-name>` with `Content-Type: application/json`. The existing trigger-ui middleware handler SHALL process the request via `registry.getEntry` + `entry.fire(body)` without any manual-kind special-case branch.

#### Scenario: Submit posts to /trigger/<t>/<w>/<name>

- **GIVEN** a manual trigger `rerun` in workflow `ops` for tenant `acme`
- **WHEN** the user clicks Submit in the trigger card
- **THEN** the browser SHALL issue `POST /trigger/acme/ops/rerun` with a JSON body
- **AND** the response SHALL be the `{ ok, output }` envelope produced by the existing trigger-ui middleware

### Requirement: Shared kind registry registers the manual kind

The shared trigger-kind registry at `packages/runtime/src/ui/triggers.ts` (consumed by both `/trigger` and `/dashboard` UIs) SHALL contain entries for `"manual"` in BOTH of the following maps:

- `KIND_ICONS.manual` — a person-themed glyph (e.g., `"\u{1F464}"` — BUST IN SILHOUETTE).
- `KIND_LABELS.manual` — a short human-readable label (e.g., `"Manual"`).

Missing-kind fallback behaviour SHALL continue to apply unchanged to unrecognised kinds (icon falls back to `"\u{25CF}"`; label falls back to the raw kind string).

#### Scenario: Manual kind icon renders with correct metadata

- **GIVEN** a manual trigger card
- **WHEN** the page is rendered
- **THEN** the icon span SHALL contain the BUST IN SILHOUETTE glyph
- **AND** the span's `title` attribute SHALL equal `"manual"`
- **AND** the span's `aria-label` attribute SHALL equal `"manual"`

#### Scenario: Manual kind label resolves to the human-readable string

- **GIVEN** the `triggerKindLabel("manual")` helper
- **WHEN** called in any UI context that displays the label
- **THEN** the returned string SHALL equal `"Manual"`

### Requirement: Manual trigger cards render no meta line

The shared `triggerCardMeta(descriptor, tenant, workflow)` helper SHALL return an empty string `""` for manual triggers. The trigger card's summary SHALL continue to render the meta container, but for manual triggers the container SHALL contain an empty string, visually collapsing the meta line.

#### Scenario: Manual trigger meta is empty

- **GIVEN** a manual trigger descriptor
- **WHEN** `triggerCardMeta(descriptor, tenant, workflow)` is called
- **THEN** the return value SHALL be the empty string `""`

#### Scenario: Manual card summary carries no meta text

- **GIVEN** a manual trigger card rendered on the `/trigger` page
- **WHEN** the summary element is inspected
- **THEN** the `.trigger-meta-text` element SHALL be empty
- **AND** no schedule, URL, or method string SHALL appear in the summary
