## MODIFIED Requirements

### Requirement: TriggerEntry carries descriptor and fire callback

The runtime SHALL define `TriggerEntry<D>` as an immutable record carrying exactly two fields:

- `readonly descriptor: D` — the kind-specific descriptor from the tenant manifest.
- `readonly fire: (input: unknown, dispatch?: DispatchMeta) => Promise<InvokeResult<unknown>>` — a callback that, when invoked, runs the workflow handler and returns a discriminated result `{ ok: true, output: unknown } | { ok: false, error: { message: string, stack?: string } }`.

Where `DispatchMeta` is `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`. When the caller omits `dispatch`, the `fire` closure SHALL treat the dispatch as `{ source: "trigger" }` and forward that default to the executor so that every invocation carries dispatch provenance (see `executor` spec "Runtime stamps runtime-engine metadata in onEvent").

The `TriggerEntry` SHALL NOT carry `tenant`, `workflow`, or `bundleSource` fields. Identity for the backend's internal bookkeeping SHALL be derived from the `tenant` argument to `reconfigure` combined with `descriptor.name` (and additional kind-specific descriptor fields where applicable). The `fire` callback SHALL capture all workflow-identity context inside its closure at construction time.

Trigger-source backends SHALL call `fire(input)` without a dispatch argument — they always represent non-manual dispatches. Only the kind-agnostic UI endpoint at `/trigger/*` SHALL pass a dispatch argument, and only with `source: "manual"` (see `trigger-ui` spec).

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
