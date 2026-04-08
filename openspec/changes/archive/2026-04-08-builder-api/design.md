## Context

The SDK currently exposes `defineWorkflow(config)` — a single function that accepts events, triggers, and actions as a nested object literal. TypeScript cannot correlate the `emits` property of an action with its `handler`'s context type because they are sibling properties with no generic bridging them. As a result, `ctx.emit()` accepts any event in the workflow, ignoring the `emits` declaration.

The `WorkflowConfig` output type is consumed by the runtime (`loader.ts`, `main.ts`) and is unchanged by this design. The builder is purely a compile-time authoring API.

## Goals / Non-Goals

**Goals:**
- `ctx.emit()` restricted at compile-time to events listed in the action's `emits` array
- `ctx.env` narrowed at compile-time to declared env keys as `Readonly<Record<Keys, string>>`
- Phase ordering enforced by the type system (events → triggers → actions → build)
- Preserve the `WorkflowConfig` output type — zero runtime changes

**Non-Goals:**
- Runtime enforcement of `emits` constraints (compile-time only)
- Runtime validation of declared env vars at startup
- Changes to the runtime context, event queue, scheduler, or dispatch
- Changes to the build system or manifest format

## Decisions

### Decision: Builder pattern with phase types

Replace `defineWorkflow(config)` with `workflow()` returning a builder that progresses through typed phases.

Each phase is a distinct TypeScript type exposing only valid methods:

```
StartPhase          → .event()
EventPhase<E>       → .event() | .trigger()
TriggerPhase<E>     → .trigger() | .action()
ActionPhase<E>      → .action() | .build()
```

**Why builder over enhanced generics on `defineWorkflow`:** Both approaches solve the type narrowing problem via generic inference at function call boundaries. The builder was chosen because:
- Each method call has isolated, simple generics — easier to maintain and debug
- TypeScript error messages are scoped to individual method calls
- Phase ordering comes for free via return types
- The alternative (second generic parameter on `defineWorkflow` with mapped conditional types) produces complex, fragile type-level code

### Decision: Generic accumulation for events

Each `.event(name, schema)` call returns a new `EventPhase<E & Record<Name, Schema>>`. The events type accumulates via intersection:

```typescript
workflow()                        // StartPhase
  .event("a", s1)                 // EventPhase<{ a: S1 }>
  .event("b", s2)                 // EventPhase<{ a: S1 } & { b: S2 }>
```

At runtime, the builder mutates internal state and returns `this` with a type assertion. The distinct phase types are a compile-time fiction over a single mutable builder instance.

**Trade-off:** Event ordering matters — triggers and actions can only reference events declared before them in the chain. This is acceptable because defining events first is the natural authoring order.

### Decision: `const` generic modifier for emits and env inference

The `.action()` method uses `const` generics to preserve literal tuple types:

```typescript
action<K extends keyof E & string,
       const Emits extends ReadonlyArray<keyof E & string> = readonly [],
       const Env extends ReadonlyArray<string> = readonly []>(...)
```

When `emits` is omitted, `Emits` defaults to `readonly []`, making `Emits[number] = never` and `Pick<EventPayloads<E>, never> = {}`. This means `ctx.emit` exists but accepts `never` — no valid call is possible.

When `env` is omitted, same mechanism: `ctx.env` becomes `Readonly<{}>`.

### Decision: Single internal builder class

One `WorkflowBuilder` class at runtime, with all methods (`event`, `trigger`, `action`, `build`). Phase restrictions are enforced purely at the type level via different interfaces that expose subsets of methods. The `workflow()` function returns the builder typed as `StartPhase`.

**Why not separate classes per phase:** Unnecessary runtime complexity for something that's purely a compile-time concern.

## Risks / Trade-offs

**[TypeScript intersection depth]** Each `.event()` adds an intersection layer to `E`. For workflows with many events (>30), TypeScript may slow down. → *Mitigation:* Realistic workflows have 5-15 events. If needed, a periodic `Simplify<E>` utility type can flatten intersections.

**[Breaking change]** All existing workflow files must be migrated. → *Mitigation:* Only one workflow file exists (`cronitor.ts`). The migration is mechanical: restructure from nested object to chained calls.

**[`ctx.env` typed as `string` but runtime value may be `undefined`]** The type is intentionally optimistic — no startup validation exists. → *Mitigation:* Accepted trade-off. Runtime env validation is a separate concern.

**[Phase ordering constraint]** Events must be declared before triggers/actions. Cannot reference a forward-declared event. → *Mitigation:* This matches natural authoring order. Events are the schema foundation.
