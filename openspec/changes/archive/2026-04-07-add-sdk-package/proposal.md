## Why

Workflow authors currently define triggers and actions as untyped plain objects with `payload: unknown`, wired imperatively in `main.ts`. There is no public API, no payload type safety, and no structured way to declare a workflow. The SDK package provides a typed authoring API (`defineWorkflow`) that gives compile-time safety for event schemas, trigger-event wiring, action-event subscriptions, and environment variable access — while producing a data structure that the runtime can consume without executing user code.

## What Changes

- Add new `@workflow-engine/sdk` package at `packages/sdk/` with Zod as a direct dependency
- Export a single `defineWorkflow` function that accepts a declarative workflow definition object with `events`, `triggers`, and `actions` sections
- Event schemas defined inline as Zod types, keyed by event type string
- Trigger and action references to events are type-checked against the `events` keys
- Internal `ActionContext` type provides typed `ctx.event.payload`, `ctx.emit()`, `ctx.env`, and `ctx.fetch()` (inferred within `defineWorkflow`, not exported)
- Actions declare `env` (list of required env variable names) and optional `emits` (list of event keys they may emit)
- Migrate `sample.ts` to use the new SDK
- Update runtime's `main.ts` to consume the `WorkflowConfig` produced by `defineWorkflow`

## Capabilities

### New Capabilities
- `define-workflow`: The `defineWorkflow` function, event/trigger/action type inference, and `WorkflowConfig` output type

### Modified Capabilities
- `sdk`: Update requirements to reflect the `defineWorkflow` object API (replacing the builder DSL), removal of the no-runtime-footprint requirement, and addition of `ctx.env`/`ctx.fetch()` to ActionContext
- `actions`: Action interface changes to support SDK-generated action definitions from `WorkflowConfig`
- `triggers`: Trigger definitions now include the event reference, produced by `defineWorkflow`
- `context`: ActionContext updated to support typed payload and typed env from SDK declarations

## Impact

- **New package**: `packages/sdk/` with `@workflow-engine/sdk` added to pnpm workspace
- **New dependency**: Zod added as direct dependency of the SDK package
- **Runtime package**: `packages/runtime/` gains a dependency on `@workflow-engine/sdk`; `main.ts` updated to consume `WorkflowConfig`
- **Breaking**: `sample.ts` rewritten; existing `Action` and `HttpTriggerDefinition` interfaces may change to align with SDK output
- **No manifest format changes** at this stage (sandbox/bridge is future work)
- **No QueueStore changes**
