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
- `type`: string --- discriminant for trigger kind (`"http"`, `"cron"`, or `"manual"`)
- Type-specific fields.
  - For `type: "http"`: `method` (string, top-level), `request` (object with required `body` and `headers` JSON Schemas), `response` (optional object whose `body` and `headers` JSON Schemas are individually optional), `inputSchema` (JSON Schema for the composite payload `{body, headers, url, method}` composed from `request.body` + `request.headers` + the declared `method`), `outputSchema` (JSON Schema for `HttpTriggerResult` whose `headers` slot is either the loose `Record<string, string>` form or — when `response.headers` is declared — that author-supplied schema). HTTP entries SHALL NOT contain top-level `body`, `responseBody`, `headers`, `responseHeaders`, `path`, `params`, or `query` fields; the request/response schemas live exclusively under the grouped `request` / `response` keys.
  - For `type: "cron"`: `schedule` (string, standard 5-field cron), `tz` (string, IANA timezone identifier), `inputSchema` (JSON Schema for the empty input object), `outputSchema` (JSON Schema for `unknown`).
  - For `type: "manual"`: `inputSchema` (JSON Schema derived from the author-provided or default `z.object({})` input schema), `outputSchema` (JSON Schema derived from the author-provided or default `z.unknown()` output schema). Manual entries SHALL NOT contain `method`, `body`, `request`, `response`, `schedule`, `tz`, `path`, `params`, or `query` fields.

The default JSON Schemas applied at build time when the author omits the corresponding zod schema:
- `request.body` omitted → JSON Schema for `z.any()` (i.e. `{}`).
- `request.headers` omitted → `{ type: "object", properties: {}, additionalProperties: false, strip: true }` (the `strip: true` marker is auto-attached by the SDK via `.meta({ strip: true })` and instructs the runtime rehydrator to reconstruct the `ZodObject` in `.strip()` mode — see http-trigger spec "Object schema strip-mode marker (`strip`)" requirement).
- `response.body` omitted → no `response.body` key in the manifest entry.
- `response.headers` omitted → no `response.headers` key in the manifest entry. When the entire `response` object would be empty (both `body` and `headers` omitted), the `response` key MAY itself be omitted from the manifest entry.

The manifest SHALL NOT contain an `events` array, action `on`/`emits` fields, per-action `module` field, per-action `env` field, or trigger `response` field of the legacy form (the new `response` object under HTTP triggers is unrelated to the deprecated workflow-level `response` field).

Secret envName keys in `secrets` SHALL be disjoint from `env` keys. A key appearing in `secrets` SHALL NOT also appear in `env`.

#### Scenario: Manifest contains workflow-level fields and per-action input/output schemas

- **GIVEN** a workflow named "cronitor" with one HTTP trigger `cronitorWebhook` and two actions
- **WHEN** the build runs
- **THEN** `manifest.json` SHALL contain `name: "cronitor"`, `module: "cronitor.js"`, `env: {...}`, an `actions` array of length 2 (each with `name`, `input`, `output`), and a `triggers` array of length 1 with `name: "cronitorWebhook"`, `type: "http"`, `method`, `request: { body, headers }`, `inputSchema`, `outputSchema`
- **AND** SHALL NOT contain an `events` array
- **AND** action entries SHALL NOT contain `on`, `emits`, `module`, or `env` fields
- **AND** trigger entries SHALL NOT contain top-level `body`, `responseBody`, `headers`, `responseHeaders`, `path`, `params`, or `query` fields

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

#### Scenario: HTTP trigger entry uses export name and grouped request/response

- **GIVEN** `export const cronitorWebhook = httpTrigger({ request: { body: z.object({ id: z.string() }) }, handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "cronitorWebhook"`, `type: "http"`, `method: "POST"`
- **AND** SHALL have `request.body` equal to the JSON Schema for `{ id: string }`
- **AND** SHALL have `request.headers` equal to `{ type: "object", properties: {}, additionalProperties: false, strip: true }` (no headers schema declared; the `strip: true` marker is auto-attached by the SDK via `.meta({ strip: true })`)
- **AND** SHALL NOT contain top-level `body`, `responseBody`, `headers`, `responseHeaders`, `path`, `params`, or `query` fields
- **AND** MAY omit the `response` key entirely when neither `response.body` nor `response.headers` is declared

#### Scenario: HTTP trigger entry with declared request.headers schema

- **GIVEN** `export const signedHook = httpTrigger({ request: { headers: z.object({ "x-hub-signature-256": z.string() }) }, handler })`
- **WHEN** the build runs
- **THEN** the trigger entry's `request.headers` SHALL be the JSON Schema for `z.object({ "x-hub-signature-256": z.string() })` with `additionalProperties: false` (Zod default on `.object()`)
- **AND** SHALL contain the top-level key `strip: true` (auto-attached by the SDK on the `request.headers` slot via `.meta({ strip: true })`)
- **AND** the `inputSchema`'s `headers` property SHALL match the same content schema (composed by `composeHttpInputSchema`)

#### Scenario: HTTP trigger entry with declared response.body and response.headers

- **GIVEN** `export const greetJson = httpTrigger({ response: { body: z.object({ ok: z.boolean() }), headers: z.object({ "x-app-version": z.string() }) }, handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `response.body` equal to the JSON Schema for `{ ok: boolean }`
- **AND** SHALL have `response.headers` equal to the JSON Schema for `{ "x-app-version": string }`
- **AND** the `outputSchema.properties.body` SHALL require the `response.body` shape
- **AND** the `outputSchema.properties.headers` content schema SHALL be the `response.headers` shape

#### Scenario: HTTP trigger entry with response.headers only

- **GIVEN** `export const tracedHook = httpTrigger({ response: { headers: z.object({ "x-app-version": z.string() }) }, handler })`
- **WHEN** the build runs
- **THEN** the trigger entry's `response.headers` SHALL be present with the declared schema
- **AND** the trigger entry SHALL NOT contain a `response.body` key (response.body omitted means no constraint)
- **AND** the `outputSchema.properties.headers` content schema SHALL be the declared headers shape

#### Scenario: Cron trigger entry with schedule and tz

- **GIVEN** `export const nightly = cronTrigger({ schedule: "0 2 * * *", tz: "Europe/Berlin", handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "nightly"`, `type: "cron"`, `schedule: "0 2 * * *"`, `tz: "Europe/Berlin"`
- **AND** SHALL have `inputSchema: {"type":"object","properties":{},"additionalProperties":false}` (or equivalent JSON Schema for `z.object({})`)
- **AND** SHALL have `outputSchema: {}` (or equivalent JSON Schema for `z.unknown()`)
- **AND** SHALL NOT contain `path`, `method`, `body`, `request`, `response`, `params`, or `query` fields

#### Scenario: Manual trigger entry with default schemas

- **GIVEN** `export const rerun = manualTrigger({ handler: async () => "ok" })` (no input/output provided)
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "rerun"`, `type: "manual"`
- **AND** SHALL have `inputSchema: {"type":"object","properties":{},"additionalProperties":false}` (or equivalent JSON Schema for `z.object({})`)
- **AND** SHALL have `outputSchema: {}` (or equivalent JSON Schema for `z.unknown()`)
- **AND** SHALL NOT contain `method`, `body`, `request`, `response`, `schedule`, `tz`, `path`, `params`, or `query` fields

#### Scenario: Manual trigger entry with author-provided schemas

- **GIVEN** `export const reprocessOrder = manualTrigger({ input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }), handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "reprocessOrder"`, `type: "manual"`
- **AND** `inputSchema` SHALL correspond to the JSON Schema of `z.object({ id: z.string() })`
- **AND** `outputSchema` SHALL correspond to the JSON Schema of `z.object({ ok: z.boolean() })`

### Requirement: ManifestSchema validation (v1)

The SDK SHALL export a `ManifestSchema` Zod object validating the v1 manifest shape. The schema SHALL require `name`, `module`, `env`, `actions`, `triggers` at the top level. The schema SHALL accept optional `secrets: Record<string, string>` (each value validated as a base64 string) and optional `secretsKeyId: string` (validated against `/^[0-9a-f]{16}$/`).

When `secrets` is present, `secretsKeyId` SHALL be required. When `secrets` is absent, `secretsKeyId` SHALL be absent. Violating this co-presence rule SHALL fail validation.

Each action entry SHALL require `name`, `input`, `output`. Each trigger entry SHALL require `name`, `type` and the type-specific fields. The trigger `name` SHALL be validated against `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`; non-matching names SHALL fail validation.

The `triggers[].type` discriminant SHALL accept the literals `"http"`, `"cron"`, and `"manual"`. HTTP entries SHALL require `name`, `method`, `request` (object with required `body` and `headers` JSON Schemas), `inputSchema`, `outputSchema`; HTTP entries SHALL accept optional `response` (object with optional `body` and optional `headers` JSON Schemas); HTTP entries SHALL NOT accept top-level `body`, `responseBody`, `headers`, `responseHeaders`, `path`, `params`, or `query` (the Zod schema SHALL reject them as excess keys or by omission from the schema shape). Cron entries SHALL require `schedule` (validated against a standard 5-field cron regex), `tz` (validated against the host's IANA timezone set — see the "IANA timezone validation" requirement), `inputSchema`, and `outputSchema`. Manual entries SHALL require `name`, `type`, `inputSchema`, and `outputSchema`; manual entries SHALL NOT accept `method`, `body`, `request`, `response`, `schedule`, `tz`, `path`, `params`, or `query`.

The runtime SHALL parse every loaded manifest through `ManifestSchema`. Invalid manifests SHALL be rejected at upload with a `422` response carrying the validation issues.

#### Scenario: Valid v1 manifest passes validation

- **WHEN** a well-formed v1 `manifest.json` is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: HTTP trigger entry missing request.body fails

- **WHEN** a manifest contains an HTTP trigger entry whose `request` object lacks the `body` JSON Schema
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error naming the missing field

#### Scenario: HTTP trigger entry missing request.headers fails

- **WHEN** a manifest contains an HTTP trigger entry whose `request` object lacks the `headers` JSON Schema
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error naming the missing field

#### Scenario: HTTP trigger entry with legacy flat fields fails

- **WHEN** a manifest contains an HTTP trigger entry with top-level `body`, `responseBody`, `headers`, or `responseHeaders` keys
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error
- **AND** the error SHALL identify the offending top-level key as not permitted on HTTP entries
