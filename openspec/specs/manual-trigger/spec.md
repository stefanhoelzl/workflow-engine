# Manual Trigger Specification

## Purpose

Define the `manualTrigger` SDK factory and its runtime `TriggerSource` implementation. Manual triggers fire workflow invocations exclusively via the authenticated `/trigger/<tenant>/<workflow>/<trigger>` UI endpoint — there is no public webhook ingress and no timer. The manual source shares the per-`(tenant, workflow.sha)` runQueue with other trigger kinds. The backend is a thin no-op; entries live in the workflow registry and the `/trigger` middleware resolves them directly via `registry.getEntry`.

## Requirements

### Requirement: manualTrigger factory creates branded ManualTrigger

The SDK SHALL export a `manualTrigger(config)` factory that returns a `ManualTrigger` value that is BOTH branded with `Symbol.for("@workflow-engine/manual-trigger")` AND callable as `(input: unknown) => Promise<unknown>`. Invoking the callable SHALL run the user-supplied `handler(input)` and return its result (the return value is preserved for callable-style usage in tests; the runtime fire path validates/serialises via the descriptor's schemas separately).

The config SHALL require:

- `handler`: `(input: unknown) => Promise<unknown>` — async handler invoked on every manual fire. The handler receives the validated payload as its only argument.

The config SHALL accept optional:

- `input`: `ZodType` — the Zod schema describing the handler's payload. If omitted, the SDK factory SHALL use `z.object({})` (handlers receive an empty object on every fire).
- `output`: `ZodType` — the Zod schema describing the handler's return value. If omitted, the SDK factory SHALL use `z.unknown()`.

The returned value SHALL expose `inputSchema` and `outputSchema` as readonly own properties. The captured `handler` SHALL NOT be exposed as a public property.

#### Scenario: manualTrigger returns branded callable

- **GIVEN** `const t = manualTrigger({ handler: async () => "ok" })`
- **WHEN** the value is inspected
- **THEN** `t` SHALL be a function (callable)
- **AND** `t[MANUAL_TRIGGER_BRAND]` SHALL be `true`
- **AND** `t.inputSchema`, `t.outputSchema` SHALL be exposed as readonly properties
- **AND** `t.handler` SHALL NOT be defined as an own property

#### Scenario: manualTrigger callable invokes the handler

- **GIVEN** `const t = manualTrigger({ handler: async (input) => input })`
- **WHEN** `await t({ hello: "world" })` is called
- **THEN** the handler SHALL be invoked with `{ hello: "world" }` and the return value SHALL be `{ hello: "world" }`

#### Scenario: Default input schema is empty object

- **GIVEN** `const t = manualTrigger({ handler: async () => {} })` (no `input` provided)
- **WHEN** the descriptor's `inputSchema` is inspected
- **THEN** `inputSchema` SHALL equal `z.object({})` (or its structural equivalent)

#### Scenario: Default output schema is unknown

- **GIVEN** `const t = manualTrigger({ handler: async () => 123 })` (no `output` provided)
- **WHEN** the descriptor's `outputSchema` is inspected
- **THEN** `outputSchema` SHALL equal `z.unknown()` (or its structural equivalent)

#### Scenario: Explicit input and output schemas are preserved

- **GIVEN** `manualTrigger({ input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }), handler })`
- **WHEN** the descriptor is inspected
- **THEN** `inputSchema` SHALL match the author-provided input schema
- **AND** `outputSchema` SHALL match the author-provided output schema

### Requirement: Manual TriggerSource native implementation

The runtime SHALL implement a `TriggerSource<"manual">` at `packages/runtime/src/triggers/manual.ts`. The source SHALL hold no per-tenant state. `reconfigure(tenant, entries)` SHALL always resolve to `{ ok: true }` without inspecting the entries. `start()` and `stop()` SHALL be no-ops.

The manual source SHALL NOT register any HTTP middleware. The manual source SHALL NOT arm any timer. The manual source SHALL NOT call `executor.invoke` directly. The only path through which a manual trigger fires is via `registry.getEntry(tenant, workflow, trigger)` followed by `entry.fire(input)` — the standard kind-agnostic manual-fire path served by the trigger-ui middleware.

The manual source SHALL be registered in the runtime's backend set so that `reconfigureBackends` dispatches manual entries to this backend. If `reconfigureBackends` receives a manual entry with no manual backend registered, it SHALL classify the failure as a missing-backend error per the existing contract (same as for any other unregistered kind).

#### Scenario: reconfigure is a no-op returning ok

- **GIVEN** a manual source constructed fresh
- **WHEN** `reconfigure("acme", entries)` is called with any number of entries (including zero)
- **THEN** the source SHALL resolve to `{ ok: true }`
- **AND** the source SHALL NOT retain any reference to the entries

#### Scenario: Manual source holds no state across reconfigures

- **GIVEN** a manual source that has been `reconfigure`d for tenants `acme` and `globex`
- **WHEN** the source's internal state is inspected
- **THEN** the source SHALL hold no per-tenant map, no timer, and no middleware registration

#### Scenario: start and stop are no-ops

- **GIVEN** a manual source
- **WHEN** `start()` and `stop()` are called in any order
- **THEN** both SHALL resolve without side effects

### Requirement: No webhook ingress for manual triggers

The HTTP trigger source SHALL continue to partition its registered entries by kind and SHALL route `/webhooks/<tenant>/<workflow>/<trigger-name>` requests only against entries of kind `"http"`. Manual triggers SHALL NOT be addressable via the `/webhooks/*` ingress. A request to `/webhooks/<t>/<w>/<manual-name>` SHALL result in a `404 Not Found` response indistinguishable from any other unknown webhook path.

#### Scenario: Webhook request targeting a manual trigger returns 404

- **GIVEN** a tenant `acme` with a workflow `ops` containing `export const rerun = manualTrigger({ handler })`
- **WHEN** a client issues `POST /webhooks/acme/ops/rerun` with any payload
- **THEN** the response status SHALL be `404 Not Found`
- **AND** the manual trigger SHALL NOT be fired
- **AND** no invocation event SHALL be emitted

### Requirement: Manual fire via /trigger UI dispatches through executor

The trigger-ui middleware's `POST /trigger/<tenant>/<workflow>/<trigger-name>` handler SHALL resolve a manual `TriggerEntry` via `registry.getEntry(tenant, workflow, trigger)` and call `entry.fire(body)` with the JSON-decoded request body. The `buildFire` closure SHALL validate the body against `descriptor.inputSchema` and dispatch through the shared executor. Validation failures SHALL return `422 Unprocessable Entity` with the Zod issues; success SHALL return `200 OK` with `{ ok: true, output }`; internal errors SHALL return `500 Internal Server Error` with the error details.

Concurrent fires for the same `(tenant, workflow.sha)` SHALL serialise through the existing `RunQueue` shared with HTTP and cron invocations; no coalescing or dropping SHALL occur.

#### Scenario: Manual fire produces an invocation via the executor

- **GIVEN** a tenant `acme` with workflow `ops` containing `export const rerun = manualTrigger({ handler: async () => "done" })`
- **AND** an authenticated session whose user is a member of `acme`
- **WHEN** the client issues `POST /trigger/acme/ops/rerun` with body `{}`
- **THEN** the trigger-ui middleware SHALL call `entry.fire({})` exactly once
- **AND** the executor SHALL dispatch through the sandbox as an ordinary invocation
- **AND** the response SHALL be `200 OK` with `{ ok: true, output: "done" }`
- **AND** an `InvocationEvent` with `kind: "trigger.request"` (and subsequent `trigger.response`) SHALL be emitted with `tenant: "acme"`, `workflow: "ops"`, `name: "rerun"` stamped by the executor

#### Scenario: Manual fire validates body against inputSchema

- **GIVEN** a manual trigger declared with `input: z.object({ id: z.string() })`
- **WHEN** the client posts `{ id: 42 }` (wrong type) to `/trigger/<t>/<w>/<name>`
- **THEN** the response SHALL be `422 Unprocessable Entity`
- **AND** the body SHALL contain `{ error: "payload_validation_failed", issues: [...] }`
- **AND** the handler SHALL NOT be invoked

#### Scenario: Manual fire serialises through the runQueue

- **GIVEN** a workflow whose manual trigger is mid-invocation (holding the per-`(tenant, workflow.sha)` runQueue)
- **WHEN** a second manual fire arrives for the same workflow
- **THEN** the second fire SHALL enqueue on the runQueue
- **AND** SHALL execute sequentially after the in-flight invocation completes
- **AND** both invocations SHALL appear in the archive

### Requirement: Manual triggers carry no audit identity on events

The runtime SHALL NOT stamp the firing user's identity (name, email, or OAuth subject) onto any event emitted during a manual-trigger invocation. `InvocationEvent`s for manual fires SHALL carry the same intrinsic metadata set as any other trigger kind: `id`, `tenant`, `workflow`, `workflowSha`, `kind`, `seq`, `ref`, `at`, `ts`, `name`, and the kind-appropriate `input`/`output`/`error` fields. No `firedBy` or equivalent field SHALL be added to `InvocationEvent` for this change.

The trigger-ui middleware SHALL NOT emit an additional structured log line attributing the fire to the session user. Authentication access logs remain the authoritative audit record for "who fired what, when."

#### Scenario: Event shape matches other trigger kinds

- **GIVEN** a manual trigger fired by an authenticated user
- **WHEN** the resulting `InvocationEvent`s are inspected
- **THEN** no event SHALL contain a `firedBy`, `invokedBy`, `user`, or `email` field
- **AND** the event shape SHALL be identical to the shape emitted by an equivalent cron-fired invocation

### Requirement: Trigger kind icon for manual triggers

The trigger-ui page SHALL render a distinct icon for manual-kind trigger cards via the `KIND_ICONS` map. The icon SHALL be a person glyph (U+1F464 BUST IN SILHOUETTE) or an equivalent person-themed glyph that is visually distinct from the http (`🌐`) and cron (`⏰`) icons.

#### Scenario: Manual trigger card renders the person icon

- **GIVEN** a tenant with a manual trigger registered
- **WHEN** a user opens `/trigger?tenant=<t>`
- **THEN** the card for the manual trigger SHALL display the person icon
- **AND** the icon's `title` and `aria-label` SHALL include the kind identifier `"manual"`
