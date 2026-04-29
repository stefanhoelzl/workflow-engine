# Workflow Manifest Specification

## Purpose

Define the external contract between the `@workflow-engine/sdk/plugin` Vite plugin (producer) and the runtime `WorkflowRegistry` + executor + trigger backends (consumers): the `manifest.json` JSON schema. Owns top-level fields (`name`, `module`, `env`, `actions`, `triggers`), the trigger discriminant union (`http` / `cron` / `manual`), per-action schema shape (JSON-Schema-only, no Zod at runtime), and trigger-specific fields (`method`, `body`, `inputSchema`, `outputSchema`, `responseBody`, `schedule`, `tz`).
## Requirements
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
  - For `type: "cron"`: `schedule` (non-empty string; grammar delegated to `cron-parser` at runtime — 5-field, 6-field, and any other form `cron-parser` accepts are valid), `tz` (string, IANA timezone identifier), `inputSchema` (JSON Schema for the empty input object), `outputSchema` (JSON Schema for `unknown`).
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

The `triggers[].type` discriminant SHALL accept the literals `"http"`, `"cron"`, and `"manual"`. HTTP entries SHALL require `name`, `method`, `request` (object with required `body` and `headers` JSON Schemas), `inputSchema`, `outputSchema`; HTTP entries SHALL accept optional `response` (object with optional `body` and optional `headers` JSON Schemas); HTTP entries SHALL NOT accept top-level `body`, `responseBody`, `headers`, `responseHeaders`, `path`, `params`, or `query` (the Zod schema SHALL reject them as excess keys or by omission from the schema shape). Cron entries SHALL require `schedule` (a non-empty string; grammar is delegated to `cron-parser` at runtime — see the "Cron trigger schedule field" requirement), `tz` (validated against the host's IANA timezone set — see the "IANA timezone validation" requirement), `inputSchema`, and `outputSchema`. Manual entries SHALL require `name`, `type`, `inputSchema`, and `outputSchema`; manual entries SHALL NOT accept `method`, `body`, `request`, `response`, `schedule`, `tz`, `path`, `params`, or `query`.

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

#### Scenario: Cron trigger with empty schedule fails

- **WHEN** a manifest contains a cron trigger with `schedule: ""`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the `schedule` field as required to be non-empty

#### Scenario: Cron trigger missing tz fails

- **WHEN** a manifest contains a cron trigger without a `tz` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the missing `tz`

#### Scenario: Manual trigger with required fields passes

- **WHEN** a manifest contains a manual trigger entry with `name`, `type: "manual"`, `inputSchema`, and `outputSchema`
- **THEN** parsing through `ManifestSchema` SHALL succeed

#### Scenario: Manual trigger with cron-only fields has them stripped

- **WHEN** a manifest contains a manual trigger entry with `schedule` and `tz` fields alongside the required `inputSchema`/`outputSchema`
- **THEN** parsing through `ManifestSchema` SHALL succeed (the discriminant routes to the manual schema)
- **AND** the parsed manual entry SHALL NOT carry `schedule` or `tz` on the resulting type (Zod's default strip behaviour, consistent with how cron entries strip http-only extras today)

#### Scenario: Manual trigger with http-only fields has them stripped

- **WHEN** a manifest contains a manual trigger entry with `method` and `body` fields alongside the required `inputSchema`/`outputSchema`
- **THEN** parsing through `ManifestSchema` SHALL succeed (the discriminant routes to the manual schema)
- **AND** the parsed manual entry SHALL NOT carry `method` or `body` on the resulting type

#### Scenario: Manual trigger missing inputSchema fails

- **WHEN** a manifest contains a manual trigger entry without `inputSchema`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the missing `inputSchema`

#### Scenario: Legacy events array rejected

- **WHEN** a manifest contains an `events` array
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

### Requirement: Manifest type exported from SDK

The SDK SHALL export a `Manifest` TypeScript type derived from `ManifestSchema` for consumers that need to work with manifest data.

#### Scenario: Manifest type matches schema

- **WHEN** a consumer imports `Manifest` from the SDK
- **THEN** the type SHALL match the shape validated by `ManifestSchema`
- **AND** SHALL expose `Manifest["actions"][number]["input"]` and `["output"]` as JSON Schema objects

### Requirement: IANA timezone validation on upload

The `ManifestSchema` Zod schema in `@workflow-engine/core` SHALL validate every cron trigger's `tz` field against the runtime host's IANA timezone set, probed once per zone via `new Intl.DateTimeFormat('en-US', { timeZone })` in a try/catch (memoized in a process-local cache), via a Zod `.refine()` predicate. The workflow upload endpoint (`POST /api/workflows/<owner>/<repo>`) already runs `ManifestSchema.parse()` on incoming manifests (see `workflow-registry.ts`); uploads with an unknown `tz` SHALL therefore be rejected with `422 Unprocessable Entity` and the Zod-reported issues.

The manifest is **repo-agnostic**: it MUST NOT declare an owner, repo, or repository field. Scope (`owner`, `repo`) is supplied exclusively by the upload URL (`POST /api/workflows/<owner>/<repo>`). The server stamps both onto stored `WorkflowEntry` records and forwards them to trigger backends via `reconfigure(owner, repo, entries)`.

#### Scenario: Known IANA timezone passes

- **GIVEN** a manifest with a cron trigger whose `tz` is `"Europe/Berlin"`
- **WHEN** `ManifestSchema.parse()` runs
- **THEN** parsing SHALL succeed

#### Scenario: Unknown IANA timezone fails

- **GIVEN** a manifest with a cron trigger whose `tz` is `"Not/AZone"`
- **WHEN** the manifest is uploaded
- **THEN** `ManifestSchema.parse()` SHALL throw with a Zod issue identifying `tz` as invalid
- **AND** the upload endpoint SHALL return `422` with the issues payload

#### Scenario: Empty tz fails

- **GIVEN** a manifest with a cron trigger whose `tz` is the empty string `""`
- **WHEN** the manifest is uploaded
- **THEN** the upload endpoint SHALL return `422`

### Requirement: Cron trigger schedule field

For trigger entries with `type: "cron"`, the manifest SHALL require:

- `schedule`: `string` — a non-empty cron expression. The manifest layer SHALL NOT constrain the grammar beyond non-emptiness; the runtime cron source's `CronExpressionParser.parse` (cron-parser) is the authoritative grammar check. Schedules MAY be 5-field, 6-field (with seconds), or any other form `cron-parser` accepts. Schedules MAY also be a workflow-secret sentinel reference.
- `tz`: `string` — an IANA timezone identifier (validated via the "IANA timezone validation" requirement) or a workflow-secret sentinel reference.
- `inputSchema`: JSON Schema for the empty input object.
- `outputSchema`: JSON Schema for `unknown`.

#### Scenario: Cron trigger entry accepts 5-field schedule

- **GIVEN** a cron trigger with `schedule: "0 2 * * *"` and `tz: "Europe/Berlin"`
- **WHEN** the manifest is parsed
- **THEN** the entry SHALL be accepted with `schedule: "0 2 * * *"` and `tz: "Europe/Berlin"`

#### Scenario: Cron trigger entry accepts 6-field schedule

- **GIVEN** a cron trigger with `schedule: "* * * * * *"` (every-second) and `tz: "UTC"`
- **WHEN** the manifest is parsed
- **THEN** the entry SHALL be accepted; `cron-parser` is the runtime authority for the grammar

#### Scenario: Cron trigger with empty schedule fails

- **WHEN** a manifest contains a cron trigger with `schedule: ""`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the `schedule` field as required to be non-empty

#### Scenario: Cron trigger with unparseable schedule reaches the runtime

- **GIVEN** a manifest containing a cron trigger with `schedule: "not a cron"`
- **WHEN** the manifest is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed (the manifest layer is permissive)
- **AND** the runtime cron source's `CronExpressionParser.parse` SHALL throw on first arm, surfacing as a `cron.schedule-invalid` log line and a no-op for that entry's timer

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

