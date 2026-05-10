## ADDED Requirements

### Requirement: Manual fire emits trigger.rejection on input validation failure

When a manual-fire POST to `/trigger/:owner/:repo/:workflow/:trigger` is rejected by the trigger's input schema, the `/trigger` UI middleware SHALL, before returning the HTTP 422 response, emit a `trigger.rejection` lifecycle event with:

- `kind: "trigger.rejection"`
- `name: "manual.input-validation"`
- `input.issues`: the engine-internal `ValidationIssue[]` array in its full enriched shape (including `received`, `expected`, `code` when supplied by the underlying validator) — NOT the minimal wire shape served in the 422 response
- `input.trigger`: the trigger name (the `:trigger` URL parameter)

Per the existing host-fail emission contract (`packages/runtime/src/executor/exception.ts`), the emitted event SHALL NOT carry `meta.dispatch` — single-leaf host-fail events have no paired `trigger.request` and follow the same dispatch-less pattern that `http.body-validation` rejection events use today. The event is identified as manual-fire-originated by its `name: "manual.input-validation"`.

The 422 response shape served to the dashboard caller is unchanged: `{ error: "payload_validation_failed", issues: [{path, message}, ...] }` with the minimal projection defined in `payload-validation/spec.md` ("HTTP 422 response for validation failures"). The persistence path and the response path are independent — the response SHALL NOT be delayed or otherwise made dependent on event emission success or failure.

The emission SHALL NOT happen for non-validation failures (e.g. handler throws, output validation failure). Those failures continue to be surfaced by the executor's existing lifecycle events.

#### Scenario: Manual fire with invalid input persists trigger.rejection

- **GIVEN** authenticated user `alice` (member of `acme`) and a manual trigger `runBatch` in `(acme, foo)` whose input schema is `z.object({ count: z.number() })`
- **WHEN** alice POSTs `/trigger/acme/foo/batch/runBatch` with body `{ "count": "many" }`
- **THEN** the runtime SHALL respond 422 with body `{ error: "payload_validation_failed", issues: [{ path: ["count"], message: "Expected number, received string" }] }`
- **AND** the runtime SHALL emit a `trigger.rejection` event with `name: "manual.input-validation"` and `input.issues[0].received === "many"`
- **AND** the invocations list SHALL render a synthetic single-leaf row for this rejection under the `(acme, foo)` scope

#### Scenario: Manual fire with valid input does not emit trigger.rejection

- **GIVEN** the same trigger as above
- **WHEN** alice POSTs with body `{ "count": 3 }`
- **THEN** no `trigger.rejection` event SHALL be emitted
- **AND** the existing `trigger.request` event SHALL be emitted as before

#### Scenario: Persisted event uses the full enriched shape

- **GIVEN** the same trigger as above with input schema `z.object({ kind: z.enum(["A","B"]) })`
- **WHEN** alice POSTs with body `{ "kind": "a" }`
- **THEN** the persisted `trigger.rejection` event's `input.issues[0]` SHALL carry `path: ["kind"]`, `received: "a"`, an `expected` describing the enum options, and a `code` identifying the enum-failure case
- **AND** the 422 response body issue SHALL carry only `path` and `message`
