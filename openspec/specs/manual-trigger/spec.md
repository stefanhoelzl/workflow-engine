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

The `/trigger` UI SHALL dispatch manual fires via `POST /trigger/:owner/:repo/:workflow/:trigger` with a JSON body matching the trigger's `input` schema. The runtime SHALL:

1. Validate `:owner` and `:repo` against their regexes; reject with `404` on failure.
2. Enforce owner-membership via `requireOwnerMember()` middleware; reject with `404` on failure.
3. Resolve the trigger entry via the manual trigger source's read-only accessor keyed by `(owner, repo, workflow, trigger)`; reject with `404` if no entry exists.
4. Invoke the entry's `fire(input)` callback and respond with the resulting `InvokeResult`.

The manual fire path SHALL NOT bypass owner-authorization. Two users belonging to different owners SHALL NOT be able to dispatch each other's triggers.

#### Scenario: Authorized user fires a manual trigger in their owner

- **GIVEN** user `alice` is a member of `acme`, and `(acme, foo)` has a manual trigger `runBatch`
- **WHEN** alice posts to `POST /trigger/acme/foo/batchWorkflow/runBatch` with a valid body
- **THEN** the runtime SHALL call the trigger's `fire(input)` and return its `InvokeResult`

#### Scenario: Non-member is denied with 404

- **GIVEN** user `alice` is NOT a member of `victim-org`
- **WHEN** alice posts to `POST /trigger/victim-org/foo/wf/tr` with any body
- **THEN** the runtime SHALL respond `404 Not Found`
- **AND** the response SHALL be indistinguishable from the response for a non-existent owner

#### Scenario: Missing entry returns 404

- **GIVEN** alice is a member of `acme` but `(acme, foo)` has no manual trigger named `ghost`
- **WHEN** alice posts to `POST /trigger/acme/foo/wf/ghost`
- **THEN** the runtime SHALL respond `404 Not Found`
### Requirement: Manual triggers carry no audit identity on events

Manual fire invocations SHALL have their dispatching user identity captured via the `meta.dispatch.user` field on the `trigger.request` event (see `invocations` spec). The manual trigger source SHALL NOT stamp or embed any additional user identity into the `trigger.request` input or any subsequent event. Workflow handler code SHALL NOT see the dispatching user's identity directly — it reads only the `input` it was called with.

#### Scenario: Manual fire by authenticated user produces meta.dispatch

- **GIVEN** authenticated user `alice` fires a manual trigger in `(acme, foo)`
- **WHEN** the `trigger.request` event is emitted
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual", user: { login: "alice", mail } }`
- **AND** `owner` SHALL be `acme` and `repo` SHALL be `foo` (stamped by the widener)
- **AND** the `input` passed to the handler SHALL NOT contain `dispatch` or `user` fields
### Requirement: Trigger kind icon for manual triggers

The trigger-ui page SHALL render a distinct icon for manual-kind trigger cards via the `KIND_ICONS` map. The icon SHALL be a person glyph (U+1F464 BUST IN SILHOUETTE) or an equivalent person-themed glyph that is visually distinct from the http (`🌐`) and cron (`⏰`) icons.

#### Scenario: Manual trigger card renders the person icon

- **GIVEN** a tenant with a manual trigger registered
- **WHEN** a user opens `/trigger?tenant=<t>`
- **THEN** the card for the manual trigger SHALL display the person icon
- **AND** the icon's `title` and `aria-label` SHALL include the kind identifier `"manual"`

### Requirement: Manual trigger descriptor string fields support secret sentinels

Any `string`-typed field of a `ManualTriggerDescriptor` in the manifest MAY carry sentinel substrings produced by the SDK's build-time `SecretEnvRef` resolution. Manual trigger descriptors currently carry only `name` plus input/output JSON Schemas; `name` is the author-visible identifier surfaced in the `/trigger` UI and SHOULD NOT be secret-sourced. The manual TriggerSource SHALL NOT itself parse, match, or recognize sentinel substrings; it receives already-resolved plaintext from the workflow-registry (see `workflow-registry` spec: "Registry resolves secret sentinels before reconfiguring backends").

This requirement exists to bind the manual-trigger backend to the shared contract: any future `string`-typed addition to `ManualTriggerDescriptor` automatically inherits sentinel resolution at the registry layer without needing backend code changes.

#### Scenario: Manual TriggerSource never observes sentinel bytes

- **GIVEN** any manifest with sentinel substrings anywhere in manual trigger descriptors
- **WHEN** `manualTriggerSource.reconfigure` is called by the registry
- **THEN** no string field reachable from the entries argument SHALL contain the byte sequence `\x00secret:`
