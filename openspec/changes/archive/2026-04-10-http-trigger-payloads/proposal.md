## Why

HTTP trigger events currently only carry the parsed JSON body as their payload. Workflows that need to inspect headers (e.g. webhook signature verification), the request path (with query params), or the HTTP method have no way to access them. Additionally, the current model lets any event be emitted by both triggers and actions, but in practice this never happens — triggers are transport-specific (HTTP, and later mail/websocket) while actions emit domain events. Making this separation explicit enables trigger-owned events with transport-specific payload shapes.

## What Changes

- **BREAKING**: Triggers implicitly define their own events. `wf.trigger(name, http({...}))` creates both the trigger config and its event. Trigger name = event name. The separate `event` field on trigger config is removed.
- **BREAKING**: HTTP trigger event payloads change from the raw body to `{ body, headers, path, method }` — a structured object carrying the full HTTP request context.
- **BREAKING**: The builder API becomes phase-typed: `TriggerPhase -> EventPhase -> ActionPhase`. Each phase only exposes methods that move forward (phases can be skipped).
- **BREAKING**: Event names must be unique across both trigger events and action events (enforced at compile-time via TypeScript).
- **BREAKING**: Actions can only `emit` action-defined events (via `wf.event()`), not trigger-defined events.
- New `http()` helper exported from the SDK that generates trigger config + the full HTTP payload schema from a body schema.
- Manifest `triggers` array drops the `event` field; trigger name is used to resolve the event from the `events` array.

## Capabilities

### New Capabilities

(None — all changes are modifications to existing capabilities.)

### Modified Capabilities

- `define-workflow`: Builder becomes phase-typed (`TriggerPhase -> EventPhase -> ActionPhase`) with two type pools (trigger events `T`, action events `E`). Triggers own their events. Unique name enforcement across pools. `emits` restricted to action events only.
- `triggers`: `HttpTriggerDefinition` drops the `event` field (trigger name = event name). HTTP trigger payload shape (`{ body, headers, path, method }`) with `http()` helper. Middleware constructs full payload. Always JSON-parses body (422 on failure).
- `workflow-manifest`: Trigger entries drop the `event` field. Trigger-owned events appear in the `events` array with their full HTTP-wrapped JSON schema.

## Impact

- **SDK package** (`packages/sdk`): New `http()` export, phase-typed builder interfaces, dual type params, `ManifestSchema` updated.
- **Runtime package** (`packages/runtime`): HTTP trigger middleware, trigger registry, workflow loader, trigger UI (forms now render full payload schema).
- **Workflows** (`workflows/`): All existing workflows must migrate to new API (cronitor: `.event()` + `.trigger()` becomes `.trigger()` with `http()`, action handlers access `payload.body.*` instead of `payload.*`).
- **Build system**: Vite plugin manifest generation must handle the new compile output (no `event` field on triggers).
- **Integration tests**: Payload shape assertions must be updated.
