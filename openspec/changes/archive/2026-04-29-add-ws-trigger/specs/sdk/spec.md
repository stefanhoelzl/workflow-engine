## ADDED Requirements

### Requirement: wsTrigger factory

The SDK SHALL export a `wsTrigger(config)` factory and its corresponding type guard `isWsTrigger(value): value is WsTrigger`. The factory returns a `WsTrigger` value branded with `Symbol.for("@workflow-engine/ws-trigger")` (exported as `WS_TRIGGER_BRAND`).

The config SHALL require:
- `request`: `ZodType` — schema for the inbound message data.
- `handler`: `(payload: { data: z.infer<typeof request> }) => Promise<z.infer<typeof response> | unknown>`.

The config SHALL accept optional:
- `response`: `ZodType` — schema for the handler return. When omitted, the SDK factory SHALL substitute `z.any()` (matching the optional-schema convention adopted for `action`, `manualTrigger`, and `httpTrigger.body`).

The returned value SHALL expose `request`, `response`, `inputSchema`, `outputSchema` as readonly own properties; the captured `handler` SHALL NOT be a public own property. `inputSchema` and `outputSchema` SHALL be the JSON Schemas derived from `request` and `response` respectively via `z.toJSONSchema()`.

The `Trigger` umbrella union exported from `@workflow-engine/sdk` SHALL be extended to include `WsTrigger` (see `triggers` capability).

#### Scenario: wsTrigger returns branded value

- **GIVEN** `const t = wsTrigger({ request: z.object({greet: z.string()}), handler: async ({data}) => ({echo: data.greet}) })`
- **WHEN** the value is inspected
- **THEN** `t[WS_TRIGGER_BRAND]` SHALL be `true`
- **AND** `isWsTrigger(t)` SHALL return `true`
- **AND** `t.request`, `t.response`, `t.inputSchema`, `t.outputSchema` SHALL be readonly own properties
- **AND** `t.handler` SHALL NOT be defined as an own property

#### Scenario: response defaults to z.any() when omitted

- **GIVEN** `const t = wsTrigger({ request: z.object({}), handler: async () => 'ok' })`
- **WHEN** the value is inspected
- **THEN** `t.response` SHALL be a `ZodAny` instance
- **AND** `t.outputSchema` SHALL be the JSON Schema for `z.any()` (i.e. `{}`)

#### Scenario: Build-time discovery via brand

- **GIVEN** a workflow file exporting both an `httpTrigger` and a `wsTrigger`
- **WHEN** `buildWorkflows()` discovers brand exports
- **THEN** the WS export SHALL be discovered via its `WS_TRIGGER_BRAND` symbol
- **AND** the resulting manifest SHALL contain a `type: "ws"` entry alongside the existing `type: "http"` entry

### Requirement: Trigger union includes WsTrigger

The SDK's exported `Trigger` umbrella type SHALL include `WsTrigger` as a union member. Consumers of `Trigger` (the workflow registry, manifest validation) SHALL handle the new union member.

#### Scenario: Trigger union covers all five kinds

- **WHEN** `Trigger` is inspected at the type level
- **THEN** the union SHALL equal `HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger | WsTrigger`
