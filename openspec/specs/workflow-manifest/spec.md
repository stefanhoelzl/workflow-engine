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
  - For `type: "http"`: `method`, `body` (JSON Schema), `inputSchema` (JSON Schema for the composite payload `{body, headers, url, method}`), `outputSchema` (JSON Schema for `HttpTriggerResult`). HTTP entries SHALL NOT contain `path`, `params`, or `query` fields.
  - For `type: "cron"`: `schedule` (non-empty string; grammar delegated to `cron-parser` at runtime — 5-field, 6-field, and any other form `cron-parser` accepts are valid), `tz` (string, IANA timezone identifier), `inputSchema` (JSON Schema for the empty input object), `outputSchema` (JSON Schema for `unknown`).
  - For `type: "manual"`: `inputSchema` (JSON Schema derived from the author-provided or default `z.object({})` input schema), `outputSchema` (JSON Schema derived from the author-provided or default `z.unknown()` output schema). Manual entries SHALL NOT contain `method`, `body`, `schedule`, `tz`, `path`, `params`, or `query` fields.

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

#### Scenario: Manual trigger entry with default schemas

- **GIVEN** `export const rerun = manualTrigger({ handler: async () => "ok" })` (no input/output provided)
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "rerun"`, `type: "manual"`
- **AND** SHALL have `inputSchema: {"type":"object","properties":{},"additionalProperties":false}` (or equivalent JSON Schema for `z.object({})`)
- **AND** SHALL have `outputSchema: {}` (or equivalent JSON Schema for `z.unknown()`)
- **AND** SHALL NOT contain `method`, `body`, `schedule`, `tz`, `path`, `params`, or `query` fields

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

The `triggers[].type` discriminant SHALL accept the literals `"http"`, `"cron"`, and `"manual"`. HTTP entries SHALL require `name`, `method`, `body`, `inputSchema`, `outputSchema`; HTTP entries SHALL NOT accept `path`, `params`, or `query` (the Zod schema SHALL reject them as excess keys or by omission from the schema shape). Cron entries SHALL require `schedule` (a non-empty string; grammar is delegated to `cron-parser` at runtime — see the "Cron trigger schedule field" requirement), `tz` (validated against the host's IANA timezone set — see the "IANA timezone validation" requirement), `inputSchema`, and `outputSchema`. Manual entries SHALL require `name`, `type`, `inputSchema`, and `outputSchema`; manual entries SHALL NOT accept `method`, `body`, `schedule`, `tz`, `path`, `params`, or `query`.

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
