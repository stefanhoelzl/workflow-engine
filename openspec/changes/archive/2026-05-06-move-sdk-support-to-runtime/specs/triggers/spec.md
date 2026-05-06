## MODIFIED Requirements

### Requirement: Reserved `trigger.` event-kind prefix

The `trigger.` event-kind prefix SHALL be reserved for the trigger plugin. Third-party plugins SHALL NOT emit events whose kind starts with `trigger.` (per `SECURITY.md §2 R-7`). Enforcement is plugin-author discipline; the sandbox core SHALL NOT reject such emissions at emit time.

#### Scenario: Only trigger plugin emits trigger.* events

- **GIVEN** a production sandbox composition including `createTriggerPlugin()`
- **WHEN** inspecting every other plugin's source (web-platform, fetch, timers, console, host-call-action, action-dispatch, wasi-telemetry)
- **THEN** no other plugin SHALL invoke `ctx.emit("trigger.*", ...)` or `ctx.request("trigger", ...)`
- **AND** every `trigger.request` / `trigger.response` / `trigger.error` event in the stream SHALL originate from the trigger plugin's hooks
