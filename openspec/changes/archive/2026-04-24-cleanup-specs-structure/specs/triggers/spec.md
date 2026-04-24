## ADDED Requirements

### Requirement: createTriggerPlugin factory

The runtime package SHALL export a `createTriggerPlugin(): Plugin` factory. The plugin SHALL implement `onBeforeRunStarted(runInput)` to emit `ctx.emit("trigger.request", runInput.name, { input: runInput.input }, { createsFrame: true })` and return truthy (creating a parent frame that nested fetch/timer/action events inherit via their `ref`). The plugin SHALL implement `onRunFinished(result, runInput)` to emit either `trigger.response` (when `result.ok`) or `trigger.error` (when `!result.ok`) with `closesFrame: true`, carrying the original `input` plus `output` or `error` as appropriate.

#### Scenario: Run emits trigger.request / trigger.response pair

- **GIVEN** a sandbox with `createTriggerPlugin()` composed and a run whose guest export returns `{ status: "ok" }`
- **WHEN** `sandbox.run("doWork", { foo: "bar" })` is called
- **THEN** `trigger.request` SHALL be emitted before guest-export invocation with `createsFrame: true`, `name: "doWork"`, `input: { foo: "bar" }`
- **AND** `trigger.response` SHALL be emitted after guest-export completion with `closesFrame: true`, `input: { foo: "bar" }`, `output: { status: "ok" }`
- **AND** `trigger.response.ref` SHALL equal `trigger.request.seq`

#### Scenario: Guest throw emits trigger.error

- **GIVEN** a guest export that throws `new Error("fail")`
- **WHEN** the run executes
- **THEN** `trigger.request` SHALL fire first (createsFrame)
- **AND** `trigger.error` SHALL fire with `closesFrame: true` and a serialized representation of the thrown error
- **AND** `sandbox.run()` SHALL return `{ ok: false, error }` with the matching serialized error

#### Scenario: Nested events inherit trigger.request as parent ref

- **GIVEN** a run where the guest calls `await fetch(url)` during execution
- **WHEN** the fetch plugin emits `fetch.request`
- **THEN** `fetch.request.ref` SHALL equal `trigger.request.seq` (the frame preserved by trigger plugin's `onBeforeRunStarted` returning truthy)

### Requirement: Trigger plugin is optional

The sandbox core SHALL NOT require the trigger plugin to be composed. A composition without the trigger plugin SHALL execute runs normally but SHALL emit no `trigger.*` events. This is valid for tests and for use cases wanting silent runs.

#### Scenario: Composition without trigger plugin

- **GIVEN** a sandbox composed without `createTriggerPlugin()`
- **WHEN** `sandbox.run("doWork", input)` executes
- **THEN** no `trigger.*` events SHALL be emitted
- **AND** `sandbox.run()` SHALL still return a `RunResult`
- **AND** guest code SHALL execute normally

### Requirement: Reserved `trigger.` event-kind prefix

The `trigger.` event-kind prefix SHALL be reserved for the trigger plugin. Third-party plugins SHALL NOT emit events whose kind starts with `trigger.` (per `SECURITY.md §2 R-7`). Enforcement is plugin-author discipline; the sandbox core SHALL NOT reject such emissions at emit time.

#### Scenario: Only trigger plugin emits trigger.* events

- **GIVEN** a production sandbox composition including `createTriggerPlugin()`
- **WHEN** inspecting every other plugin's source (web-platform, fetch, timers, console, host-call-action, sdk-support, wasi-telemetry)
- **THEN** no other plugin SHALL invoke `ctx.emit("trigger.*", ...)` or `ctx.request("trigger", ...)`
- **AND** every `trigger.request` / `trigger.response` / `trigger.error` event in the stream SHALL originate from the trigger plugin's hooks
