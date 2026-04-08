## Why

The current `defineWorkflow` API cannot enforce that `ctx.emit()` is restricted to the events declared in an action's `emits` array. This is because TypeScript cannot flow a property's value into a sibling property's generic type within a single object literal. A builder pattern introduces generic function call boundaries that enable per-action type narrowing for both `emits` and `env`.

## What Changes

- **BREAKING**: Replace `defineWorkflow(config)` with a fluent `workflow()` builder API
- **BREAKING**: Export renamed from `defineWorkflow` to `workflow`
- `ctx.emit()` restricted at compile-time to only events listed in the action's `emits` array; omitting `emits` makes `ctx.emit` accept `never`
- `ctx.env` narrowed to `Readonly<Record<DeclaredKeys, string>>`; omitting `env` yields `Readonly<{}>`
- Builder enforces phase ordering via distinct types: `workflow()` -> `.event()` -> `.trigger()` -> `.action()` -> `.build()`
- At least one event, one trigger, and one action required to reach `.build()`
- `WorkflowConfig` output type unchanged — runtime is not affected

## Capabilities

### New Capabilities

_None — this restructures the existing workflow definition API._

### Modified Capabilities

- `define-workflow`: Replaces single-function API with phased builder; changes event/trigger/action definition from config object to chained method calls; adds type-level phase ordering enforcement
- `actions`: `ctx.emit()` narrowed to `emits` declaration; `ctx.env` narrowed to declared keys as `Readonly<Record<Keys, string>>`

## Impact

- **SDK package** (`packages/sdk/src/index.ts`): Full rewrite of public API — new builder classes/types replace `defineWorkflow` function and `ActionInput`/`ActionContext` types
- **SDK tests** (`packages/sdk/src/define-workflow.test.ts`): Full rewrite for new API
- **Workflow files** (`workflows/cronitor.ts`): Migration to builder syntax
- **Specs**: `define-workflow/spec.md` and `actions/spec.md` require updates
- **Runtime**: No changes — `WorkflowConfig` output type is unchanged
- **No impact** on QueueStore interface, manifest format, or sandbox boundary
