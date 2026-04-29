## ADDED Requirements

### Requirement: WS trigger manifest variant

The `triggers[]` discriminator union in `manifest.json` SHALL accept `type: "ws"` as a fifth variant alongside `"http"`, `"cron"`, `"manual"`, and `"imap"`.

A WS trigger entry SHALL have:
- `name`: string — derived from the export name; SHALL match `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`.
- `type`: `"ws"`.
- `request`: object — JSON Schema for the inbound message data (derived from the author's `request` zod schema). Required.
- `response`: object — JSON Schema for the handler's reply (derived from the author's `response` zod schema, defaulting to the JSON Schema for `z.any()` when omitted). Required (with the `z.any()` default applied at build time).
- `inputSchema`: object — JSON Schema for the composite payload `{data}`. Composed at build time as `{type: "object", properties: {data: <request>}, required: ["data"], additionalProperties: false}`.
- `outputSchema`: object — JSON Schema for the handler return (equal to `response`).

WS trigger entries SHALL NOT contain `method`, `body`, `responseBody`, `headers`, `responseHeaders`, `path`, `params`, `query`, `schedule`, `tz`, `mode`, `mailbox`, `host`, or `port` fields.

`ManifestSchema` SHALL extend its trigger discriminator to validate the new variant. Pre-existing manifests without WS triggers SHALL remain valid without modification.

#### Scenario: WS trigger entry shape

- **GIVEN** `export const echo = wsTrigger({ request: z.object({greet: z.string()}), response: z.object({echo: z.string()}), handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "echo"`, `type: "ws"`
- **AND** `request` SHALL be the JSON Schema for `{greet: string}`
- **AND** `response` SHALL be the JSON Schema for `{echo: string}`
- **AND** `inputSchema.properties.data` SHALL equal `request`
- **AND** the entry SHALL NOT contain `method`, `schedule`, `mailbox`, or any other kind-specific field

#### Scenario: WS trigger with response omitted

- **GIVEN** `wsTrigger({ request: z.object({}), handler: async () => 'ok' })`
- **WHEN** the build runs
- **THEN** the trigger entry's `response` SHALL be the JSON Schema for `z.any()` (i.e. `{}`)

#### Scenario: ManifestSchema rejects mixed kind fields

- **GIVEN** a manifest entry with `type: "ws"` AND a top-level `schedule` field
- **WHEN** `ManifestSchema.safeParse` runs
- **THEN** validation SHALL fail
