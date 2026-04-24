## MODIFIED Requirements

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
