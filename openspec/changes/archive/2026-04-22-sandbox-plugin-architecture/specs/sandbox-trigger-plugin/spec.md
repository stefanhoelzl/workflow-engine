## ADDED Requirements

### Requirement: createTriggerPlugin factory

The runtime package SHALL export a `createTriggerPlugin(): Plugin` factory. The plugin SHALL implement `onBeforeRunStarted(runInput)` to emit `ctx.emit("trigger.request", runInput.name, { input: runInput.input }, { createsFrame: true })` and return truthy. The plugin SHALL implement `onRunFinished(result, runInput)` to emit either `trigger.response` (if `result.ok`) or `trigger.error` (if `!result.ok`) with `closesFrame: true`, carrying the original `input` plus `output` or `error` as appropriate.

#### Scenario: Run emits trigger.request/response pair

- **GIVEN** a sandbox with `createTriggerPlugin()` composed, and a run where the guest export returns `{ status: "ok" }`
- **WHEN** `sandbox.run("doWork", { foo: "bar" })` is called
- **THEN** before guest-export invocation, `trigger.request` SHALL be emitted with `createsFrame: true`, `name: "doWork"`, `input: { foo: "bar" }`
- **AND** after guest-export completion, `trigger.response` SHALL be emitted with `closesFrame: true`, `input: { foo: "bar" }`, `output: { status: "ok" }`
- **AND** `trigger.response.ref` SHALL equal `trigger.request.seq`

#### Scenario: Guest throw emits trigger.error

- **GIVEN** a guest export that throws `new Error("fail")`
- **WHEN** the run executes
- **THEN** `trigger.request` SHALL be emitted first
- **AND** `trigger.error` SHALL be emitted with `closesFrame: true` and `error` being a serialized representation of the thrown error
- **AND** `sandbox.run()` SHALL return `{ ok: false, error }` with the same serialized error

#### Scenario: Nested events inherit trigger.request as parent

- **GIVEN** a run where the guest calls `await fetch(url)` during execution
- **WHEN** the fetch plugin emits `fetch.request`
- **THEN** `fetch.request.ref` SHALL equal `trigger.request.seq` (the frame preserved by trigger plugin's onBeforeRunStarted returning truthy)

### Requirement: Trigger is optional

The sandbox core SHALL NOT require the trigger plugin to be present. A composition without the trigger plugin SHALL execute runs normally but emit no `trigger.*` events. This composition SHALL be valid for tests and for use cases that want silent runs.

#### Scenario: Composition without trigger plugin

- **GIVEN** a sandbox composed without `createTriggerPlugin()`
- **WHEN** `sandbox.run("doWork", input)` executes
- **THEN** no `trigger.*` events SHALL be emitted
- **AND** `sandbox.run()` SHALL still return a `RunResult`
- **AND** guest code SHALL execute normally

### Requirement: Reserved trigger prefix

The `trigger.` event-kind prefix SHALL be reserved for the trigger plugin. Plugins SHALL NOT emit events whose kind starts with `trigger.`. Violation is plugin-author discipline; not enforced by the sandbox at emit time.

#### Scenario: Only trigger plugin emits trigger.* events

- **GIVEN** a production sandbox composition including `createTriggerPlugin()`
- **WHEN** inspecting the source of every other plugin in the catalog (web-platform, fetch, timers, console, host-call-action, sdk-support, wasi)
- **THEN** no other plugin SHALL invoke `ctx.emit("trigger.", ...)` or `ctx.request("trigger", ...)`
- **AND** all `trigger.request` / `trigger.response` / `trigger.error` events in the stream SHALL originate from the trigger plugin's hooks
