## 1. Builder Types and Implementation

- [x] 1.1 Define phase interfaces (`StartPhase`, `EventPhase<E>`, `TriggerPhase<E>`, `ActionPhase<E>`) with method signatures and generic constraints
- [x] 1.2 Update `ActionContext` type: `emit` narrowed via `Emits` generic, `env` as `Readonly<Record<Env, string>>`
- [x] 1.3 Implement `WorkflowBuilder` class with `event()`, `trigger()`, `action()`, `build()` methods
- [x] 1.4 Export `workflow()` factory function returning `StartPhase`, remove `defineWorkflow` export

## 2. Type-Level Tests

- [x] 2.1 Test: valid emit compiles when event is in `emits` array
- [x] 2.2 Test: emit of event not in `emits` array is compile error
- [x] 2.3 Test: emit with unknown event name is compile error
- [x] 2.4 Test: emit with wrong payload type is compile error
- [x] 2.5 Test: no `emits` declaration makes `ctx.emit` accept `never`
- [x] 2.6 Test: `ctx.env` narrowed to declared keys, readonly, typed as `string`
- [x] 2.7 Test: no `env` declaration makes `ctx.env` an empty readonly record
- [x] 2.8 Test: invalid event reference in trigger is compile error
- [x] 2.9 Test: invalid event reference in action `on` is compile error
- [x] 2.10 Test: phase ordering enforced (e.g. `.trigger()` before `.event()` fails)

## 3. Runtime Tests

- [x] 3.1 Test: `.build()` returns correct `WorkflowConfig` structure (events, triggers, actions)
- [x] 3.2 Test: action names derived from `.action()` first argument
- [x] 3.3 Test: `emits` and `env` arrays preserved in config, default to `[]` when omitted
- [x] 3.4 Test: trigger definitions passed through to config

## 4. Migration

- [x] 4.1 Migrate `workflows/cronitor.ts` to builder API
- [x] 4.2 Verify `pnpm lint`, `pnpm check`, and `pnpm test` pass
