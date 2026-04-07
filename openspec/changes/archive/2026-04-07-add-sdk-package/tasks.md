## 1. Package Setup

- [x] 1.1 Create `packages/sdk/` directory with `package.json` (`@workflow-engine/sdk`, raw `.ts` exports, Zod as direct dependency)
- [x] 1.2 Add `packages/sdk` to pnpm workspace and install dependencies
- [x] 1.3 Create `packages/sdk/tsconfig.json` extending the base config

## 2. Core Types

- [x] 2.1 Spike: verify TypeScript discriminated union inference flows `on` field to handler `ctx` type within a generic function (create a minimal type test)
- [x] 2.2 Define `EventDefinition` type (event type string → Zod schema mapping)
- [x] 2.3 Define `HttpTriggerDefinition` type with `type: 'http'`, `path`, `method` (optional, default `'POST'`), `event` (constrained to event keys), `response`
- [x] 2.4 Define `TriggerDefinition` discriminated union on `type` (only `http` variant for now)
- [x] 2.5 Define `ActionDefinition` type with `on` (constrained to event keys), `handler`, optional `env`, optional `emits` (constrained to event keys)
- [x] 2.6 Define `ActionContext` generic type with typed `ctx.event.payload`, `ctx.emit()`, `ctx.env`, `ctx.fetch()`
- [x] 2.7 Define `WorkflowConfig` output type

## 3. defineWorkflow Implementation

- [x] 3.1 Implement `defineWorkflow` function that accepts `{ events, triggers, actions }` and returns `WorkflowConfig`
- [x] 3.2 Add default `method: 'POST'` for HTTP triggers without explicit method
- [x] 3.3 Export `defineWorkflow` and `ActionContext` from `packages/sdk/src/index.ts`

## 4. Tests

- [x] 4.1 Type-level tests: valid event references in triggers and actions compile, invalid references produce errors
- [x] 4.2 Type-level tests: `ctx.event.payload` typed from consumed event schema, `ctx.emit` restricted to declared emits, `ctx.env` narrowed to declared keys
- [x] 4.3 Type-level tests: `ctx.emit` is `never` when `emits` is omitted
- [x] 4.4 Runtime tests: `defineWorkflow` returns correct `WorkflowConfig` structure (action names from keys, trigger method defaults, event mappings)
- [x] 4.5 Runtime tests: `WorkflowConfig` actions produce correct `match` predicates (type + targetAction)

## 5. Runtime Integration

- [x] 5.1 Add `@workflow-engine/sdk` as dependency of `@workflow-engine/runtime`
- [x] 5.2 Update `main.ts` to consume `WorkflowConfig` — extract triggers for `HttpTriggerRegistry`, extract actions for `Scheduler`
- [x] 5.3 Migrate `sample.ts` to use `defineWorkflow` with Zod schemas for CronitorPayload

## 6. Verification

- [x] 6.1 Verify `pnpm lint` passes
- [x] 6.2 Verify `pnpm check` passes (TypeScript strict mode)
- [x] 6.3 Verify `pnpm test` passes (all existing + new tests)
