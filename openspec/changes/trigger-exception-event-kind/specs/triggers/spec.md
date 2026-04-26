## MODIFIED Requirements

### Requirement: TriggerEntry carries descriptor and fire callback

The runtime SHALL define `TriggerEntry<D>` as an immutable record carrying exactly three fields:

- `readonly descriptor: D` — the kind-specific descriptor from the tenant manifest.
- `readonly fire: (input: unknown, dispatch?: DispatchMeta) => Promise<InvokeResult<unknown>>` — a callback that, when invoked, runs the workflow handler and returns a discriminated result `{ ok: true, output: unknown } | { ok: false, error: { message: string, stack?: string } }`.
- `readonly exception: (params: { name: string, error: { message: string }, details?: Readonly<Record<string, unknown>> }) => Promise<void>` — a callback for *author-fixable pre-dispatch failures* that occur outside any handler run (e.g. IMAP misconfig, broken cron expression). Calling `exception` produces exactly one `trigger.exception` leaf event on the bus, fully stamped with the `TriggerEntry`'s identity. The callback's identity binding (`owner`, `repo`, `workflow`, `descriptor`) is captured at construction time, parallel to `fire`. Failure-category discriminator (`name`) and stage-specific payload (`details`) are call-time so a single source can surface multiple failure categories without re-binding.

Where `DispatchMeta` is `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`. When the caller omits `dispatch`, the `fire` closure SHALL treat the dispatch as `{ source: "trigger" }` and forward that default to the executor so that every invocation carries dispatch provenance (see `executor` spec "Runtime stamps runtime-engine metadata in onEvent").

The `TriggerEntry` SHALL NOT carry `tenant`, `workflow`, or `bundleSource` fields. Identity for the backend's internal bookkeeping SHALL be derived from the `tenant` argument to `reconfigure` combined with `descriptor.name` (and additional kind-specific descriptor fields where applicable). Both the `fire` and `exception` callbacks SHALL capture all workflow-identity context inside their closures at construction time.

Trigger-source backends SHALL call `fire(input)` without a dispatch argument — they always represent non-manual dispatches. Only the kind-agnostic UI endpoint at `/trigger/*` SHALL pass a dispatch argument, and only with `source: "manual"` (see `trigger-ui` spec).

Trigger-source backends SHALL call `exception(params)` for any author-fixable pre-dispatch failure they want to surface to the dashboard. Backends SHALL NOT emit `trigger.exception` events directly via the `EventBus`, the executor, or any free-floating stamping helper — the `entry.exception` callable is the source's only outbound channel for failure events, mirroring the `entry.fire` callable for handler dispatch. Engine-bug failures (e.g. `entry.fire` itself throws) are out of scope and SHALL be reported via `Logger.error` only, with no event.

#### Scenario: Backend routes protocol event to fire

- **GIVEN** a TriggerSource holding a TriggerEntry for a given trigger
- **WHEN** a native protocol event arrives (HTTP request, cron tick, …)
- **THEN** the backend SHALL normalize the event into an `input: unknown` shape matching the descriptor's `inputSchema`
- **AND** the backend SHALL call `entry.fire(input)` without a dispatch argument and await the result
- **AND** the backend SHALL translate the result back into its native protocol response (HTTP response body/status, cron log, …)

#### Scenario: UI endpoint passes manual dispatch

- **GIVEN** the `/trigger/*` middleware handling an authenticated user's Submit click
- **WHEN** the middleware calls `entry.fire(input, { source: "manual", user: { name, mail } })`
- **THEN** the fire closure SHALL forward that dispatch to `executor.invoke` unchanged

#### Scenario: Backend never constructs fire itself

- **GIVEN** any TriggerSource implementation
- **WHEN** its source code is inspected
- **THEN** it SHALL NOT construct `fire` closures
- **AND** it SHALL NOT reference `executor.invoke`
- **AND** it SHALL NOT import from `packages/runtime/src/executor/`
- **AND** it SHALL NOT construct a `DispatchMeta` value with `source: "manual"`

#### Scenario: Omitted dispatch defaults to trigger

- **GIVEN** a fire closure built by `buildFire`
- **WHEN** the closure is invoked as `fire(validInput)` with no second argument
- **THEN** the closure SHALL call `executor.invoke(..., { bundleSource, dispatch: { source: "trigger" } })` or equivalently `executor.invoke(..., { bundleSource })` with the executor defaulting internally

#### Scenario: Backend surfaces pre-dispatch failure via entry.exception

- **GIVEN** a TriggerSource that detects an author-fixable pre-dispatch failure (e.g. IMAP `connect-failed`, search expression rejected) for a particular `TriggerEntry`
- **WHEN** the backend wants the failure to appear in the dashboard
- **THEN** the backend SHALL call `entry.exception({ name, error, details })` exactly once
- **AND** the call SHALL produce exactly one `trigger.exception` event on the bus, fully stamped with the entry's identity (`owner`, `repo`, `workflow`, `workflowSha`, a fresh `evt_*` invocationId)
- **AND** the backend SHALL NOT emit any other event for that failure

#### Scenario: Backend never constructs exception itself

- **GIVEN** any TriggerSource implementation
- **WHEN** its source code is inspected
- **THEN** it SHALL NOT construct `exception` closures
- **AND** it SHALL NOT reference `executor.fail`
- **AND** it SHALL NOT import the `EventBus` or any direct `trigger.exception` stamping helper
- **AND** the only outbound channel for trigger failures SHALL be `entry.exception(params)` on each `TriggerEntry`
