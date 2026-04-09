## Why

Events carry no information about who emitted them. Tracing whether an event originated from a trigger or an action requires walking `parentEventId` chains. Adding explicit source fields improves observability by making event origin immediately visible.

## What Changes

- Add two required fields to `RuntimeEvent`: `sourceType` (`'trigger' | 'action'`) and `sourceName` (the trigger/action name string)
- **BREAKING**: `RuntimeEvent` schema gains two required fields — persisted events without them will fail parsing
- Thread the trigger name through the SDK and runtime (currently `WorkflowBuilder.trigger()` discards its `name` parameter)
- `EventFactory.create()` and `EventFactory.derive()` gain a `source` parameter (the name); the factory infers `sourceType` from which method is called
- `EventFactory.fork()` inherits `sourceType`/`sourceName` from the parent event
- DuckDB event store gains two new columns: `sourceType TEXT NOT NULL`, `sourceName TEXT NOT NULL`

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `events`: RuntimeEvent type gains `sourceType` and `sourceName` required fields
- `event-factory`: `create` and `derive` gain a `source` parameter; `fork` inherits source from parent
- `event-store`: DuckDB schema and row mapping include `sourceType`/`sourceName` columns
- `triggers`: `HttpTriggerDefinition`, `HttpTriggerResolved`, and `TriggerInput` gain a `name` field; `WorkflowBuilder.trigger()` stores the name
- `define-workflow`: SDK `TriggerInput` type includes `name`; `WorkflowConfig.triggers` carries trigger names

## Impact

- **SDK package** (`packages/sdk`): `TriggerInput`, `WorkflowBuilder`, `WorkflowConfig` types change
- **Runtime package** (`packages/runtime`): `RuntimeEvent` schema, `EventFactory`, `ContextFactory`, `EventStore` DDL, `HttpTriggerRegistry`
- **Tests**: All `makeEvent()` helpers across 6 test files need `sourceType`/`sourceName`
- No sandbox boundary impact — source fields are set by the runtime, not user code
- No QueueStore/persistence interface changes — fields flow through existing JSON serialization
- No manifest format changes
