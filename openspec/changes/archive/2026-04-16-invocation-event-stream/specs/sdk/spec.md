## MODIFIED Requirements

### Requirement: action factory returns typed callable

`action({ input, output, handler })` SHALL return a branded callable. When invoked, the callable SHALL delegate to `dispatchAction(name, input, handler, outputSchema)` from `@workflow-engine/core`. The callable SHALL NOT contain dispatch logic (no `__hostCallAction` lookup, no handler invocation, no output parsing).

#### Scenario: Action handle is callable and branded
- **WHEN** `action({ input: z.string(), output: z.number(), handler: async (s) => s.length })` is called
- **THEN** the returned value SHALL be callable, carry the `ACTION_BRAND`, and expose `input`, `output`, `handler`, and `name` properties

#### Scenario: Callable delegates to dispatchAction
- **WHEN** the action callable is invoked with an input value
- **THEN** it SHALL call `dispatchAction(name, input, handler, outputSchema)` from core and return its result

#### Scenario: No runtime logic in callable
- **WHEN** the action callable is invoked
- **THEN** it SHALL NOT directly call `__hostCallAction`, `handler()`, or `outputSchema.parse()` — all of that is the dispatcher's responsibility
