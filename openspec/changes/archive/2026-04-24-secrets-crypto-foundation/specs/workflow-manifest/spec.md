## MODIFIED Requirements

### Requirement: Manifest JSON format (v1)

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: `name`, `module`, `env`, `actions`, `triggers`, and optionally `secrets` and `secretsKeyId`. The manifest SHALL NOT contain executable code or function references.

The top-level fields:
- `name`: string --- workflow name (`defineWorkflow({name})` if provided, otherwise the workflow file's filestem)
- `module`: string --- relative path to the bundled workflow JS file (e.g., `"cronitor.js"`). One bundle per workflow.
- `env`: `Record<string, string>` --- workflow-level resolved env values (plaintext).
- `secrets`: optional `Record<string, string>` --- base64-encoded libsodium `crypto_box_seal` ciphertexts keyed by envName. Each value is the result of sealing the plaintext env value with the server's primary X25519 public key. When present, `secretsKeyId` SHALL also be present.
- `secretsKeyId`: optional `string` --- 16-character lowercase hex fingerprint (per `computeKeyId`) of the X25519 public key that sealed the `secrets` ciphertexts. Required when `secrets` is present, absent when `secrets` is absent.

Each action entry SHALL have:
- `name`: string --- derived from the workflow file's export name
- `input`: object --- JSON Schema for the action's input (from the action's Zod input schema)
- `output`: object --- JSON Schema for the action's output (from the action's Zod output schema)

Each trigger entry SHALL have:
- `name`: string --- derived from the export name; SHALL match `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` for URL-safety
- `type`: string --- discriminant for trigger kind (`"http"` or `"cron"`)
- Type-specific fields.
  - For `type: "http"`: `method`, `body` (JSON Schema), `inputSchema` (JSON Schema for the composite payload `{body, headers, url, method}`), `outputSchema` (JSON Schema for `HttpTriggerResult`). HTTP entries SHALL NOT contain `path`, `params`, or `query` fields.
  - For `type: "cron"`: `schedule` (string, standard 5-field cron), `tz` (string, IANA timezone identifier), `inputSchema` (JSON Schema for the empty input object), `outputSchema` (JSON Schema for `unknown`).

The manifest SHALL NOT contain an `events` array, action `on`/`emits` fields, per-action `module` field, per-action `env` field, or trigger `response` field.

Secret envName keys in `secrets` SHALL be disjoint from `env` keys. A key appearing in `secrets` SHALL NOT also appear in `env`.

#### Scenario: Manifest contains workflow-level fields and per-action input/output schemas

- **GIVEN** a workflow named "cronitor" with one HTTP trigger `cronitorWebhook` and two actions
- **WHEN** the build runs
- **THEN** `manifest.json` SHALL contain `name: "cronitor"`, `module: "cronitor.js"`, `env: {...}`, an `actions` array of length 2 (each with `name`, `input`, `output`), and a `triggers` array of length 1 with `name: "cronitorWebhook"`, `type: "http"`, `method`, `body`, `inputSchema`, `outputSchema`
- **AND** SHALL NOT contain an `events` array
- **AND** action entries SHALL NOT contain `on`, `emits`, `module`, or `env` fields
- **AND** trigger entries SHALL NOT contain `response`, `path`, `params`, or `query` fields

#### Scenario: Manifest without secrets has no secrets fields

- **GIVEN** a workflow with no `env({secret:true})` bindings (or a build produced before the workflow-secrets feature)
- **WHEN** the build runs
- **THEN** the resulting manifest SHALL NOT contain a `secrets` field
- **AND** SHALL NOT contain a `secretsKeyId` field

#### Scenario: Manifest with secrets has both fields

- **GIVEN** a workflow with at least one sealed secret binding
- **WHEN** the manifest is written
- **THEN** the manifest SHALL contain `secrets: Record<string, base64>`
- **AND** SHALL contain `secretsKeyId: <16-char-hex>`

#### Scenario: Workflow name defaults to filestem

- **GIVEN** a workflow file `workflows/cronitor.ts` with `defineWorkflow()` (no name)
- **WHEN** the build runs
- **THEN** the manifest SHALL have `name: "cronitor"`

#### Scenario: HTTP trigger entry uses export name

- **GIVEN** `export const cronitorWebhook = httpTrigger({ body: z.object({ id: z.string() }), handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "cronitorWebhook"`, `type: "http"`, `method: "POST"`, `body: <JSON Schema for {id: string}>`, `inputSchema: <composite>`, `outputSchema: <HttpTriggerResult>`
- **AND** SHALL NOT contain `path`, `params`, or `query` fields

#### Scenario: Cron trigger entry with schedule and tz

- **GIVEN** `export const nightly = cronTrigger({ schedule: "0 2 * * *", tz: "Europe/Berlin", handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "nightly"`, `type: "cron"`, `schedule: "0 2 * * *"`, `tz: "Europe/Berlin"`
- **AND** SHALL have `inputSchema: {"type":"object","properties":{},"additionalProperties":false}` (or equivalent JSON Schema for `z.object({})`)
- **AND** SHALL have `outputSchema: {}` (or equivalent JSON Schema for `z.unknown()`)
- **AND** SHALL NOT contain `path`, `method`, `body`, `params`, or `query` fields

### Requirement: ManifestSchema validation (v1)

The SDK SHALL export a `ManifestSchema` Zod object validating the v1 manifest shape. The schema SHALL require `name`, `module`, `env`, `actions`, `triggers` at the top level. The schema SHALL accept optional `secrets: Record<string, string>` (each value validated as a base64 string) and optional `secretsKeyId: string` (validated against `/^[0-9a-f]{16}$/`).

When `secrets` is present, `secretsKeyId` SHALL be required. When `secrets` is absent, `secretsKeyId` SHALL be absent. Violating this co-presence rule SHALL fail validation.

Each action entry SHALL require `name`, `input`, `output`. Each trigger entry SHALL require `name`, `type` and the type-specific fields. The trigger `name` SHALL be validated against `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`; non-matching names SHALL fail validation.

The `triggers[].type` discriminant SHALL accept the literals `"http"` and `"cron"`. HTTP entries SHALL require `name`, `method`, `body`, `inputSchema`, `outputSchema`; HTTP entries SHALL NOT accept `path`, `params`, or `query` (the Zod schema SHALL reject them as excess keys or by omission from the schema shape). Cron entries SHALL require `schedule` (validated against a standard 5-field cron regex), `tz` (validated against the host's IANA timezone set — see the "IANA timezone validation" requirement), `inputSchema`, and `outputSchema`.

The runtime SHALL parse every loaded manifest through `ManifestSchema`. Invalid manifests SHALL be rejected at upload with a `422` response carrying the validation issues.

#### Scenario: Valid v1 manifest passes validation

- **WHEN** a well-formed v1 `manifest.json` is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Manifest missing required top-level field fails

- **WHEN** a manifest is missing `name`, `module`, or `actions`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Manifest with secrets and matching secretsKeyId passes

- **WHEN** a manifest has `secrets: {TOKEN: "<b64>"}` and `secretsKeyId: "a1b2c3d4e5f60718"`
- **THEN** parsing SHALL succeed

#### Scenario: Manifest with secrets but no secretsKeyId fails

- **WHEN** a manifest has `secrets: {...}` but no `secretsKeyId` field
- **THEN** parsing SHALL throw a validation error naming the missing `secretsKeyId`

#### Scenario: Manifest with secretsKeyId but no secrets fails

- **WHEN** a manifest has `secretsKeyId: "..."` but no `secrets` field
- **THEN** parsing SHALL throw a validation error

#### Scenario: secretsKeyId with wrong format fails

- **WHEN** a manifest has `secretsKeyId: "TOO-LONG-OR-UPPERCASE"`
- **THEN** parsing SHALL throw a validation error identifying the field

#### Scenario: Action entry missing input schema fails

- **WHEN** a manifest contains an action entry without `input`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: HTTP trigger with legacy path field fails

- **WHEN** a manifest contains an HTTP trigger entry with a `path` field (legacy tarball from before this change)
- **THEN** parsing through `ManifestSchema` SHALL reject the manifest (the `path` field is not part of the HTTP entry schema)

#### Scenario: HTTP trigger with non-URL-safe name fails

- **WHEN** a manifest contains an HTTP trigger entry with `name: "$weird"` or `name: "has space"`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the `name` field as not matching the identifier regex

#### Scenario: Cron trigger with invalid schedule fails

- **WHEN** a manifest contains a cron trigger with `schedule: "not a cron"` (does not match the 5-field pattern)
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the `schedule` field

#### Scenario: Cron trigger missing tz fails

- **WHEN** a manifest contains a cron trigger without a `tz` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the missing `tz`

#### Scenario: Legacy events array rejected

- **WHEN** a manifest contains an `events` array
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error
