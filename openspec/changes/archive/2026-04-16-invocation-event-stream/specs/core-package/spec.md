## MODIFIED Requirements

### Requirement: Core package provides shared contract types
The `@workflow-engine/core` package SHALL export the shared contract consumed by both SDK and runtime. It SHALL contain `ManifestSchema` (Zod validator), `Manifest` type, `HttpTriggerResult` type, `HttpTriggerPayload` type, `InvocationEvent` interface, `EventKind` type, `ActionDispatcher` type, `dispatchAction()` accessor function, and a `z` re-export from Zod v4. It SHALL depend only on `zod` and `ajv`.

#### Scenario: Runtime imports manifest validation from core
- **WHEN** the runtime imports `ManifestSchema` and `Manifest`
- **THEN** they resolve from `@workflow-engine/core`

#### Scenario: Runtime imports z from core
- **WHEN** the runtime imports `z` from `@workflow-engine/core`
- **THEN** it receives the Zod v4 `z` namespace

#### Scenario: Runtime imports HttpTriggerResult from core
- **WHEN** the runtime imports `HttpTriggerResult`
- **THEN** it resolves from `@workflow-engine/core`

#### Scenario: SDK and runtime import InvocationEvent from core
- **WHEN** any package imports `InvocationEvent` or `EventKind`
- **THEN** they resolve from `@workflow-engine/core`

#### Scenario: SDK imports dispatchAction from core
- **WHEN** the SDK's `action()` callable needs to dispatch
- **THEN** it calls `dispatchAction(name, input, handler, outputSchema)` imported from `@workflow-engine/core`

#### Scenario: dispatchAction reads globalThis.__dispatchAction
- **WHEN** `dispatchAction(name, input, handler, outputSchema)` is called
- **THEN** it SHALL read `globalThis.__dispatchAction`, call it with the four arguments, and return its result

#### Scenario: dispatchAction throws when no dispatcher installed
- **WHEN** `globalThis.__dispatchAction` is not a function
- **THEN** `dispatchAction()` SHALL throw an error indicating no dispatcher is installed

#### Scenario: ActionDispatcher type describes the dispatch function
- **WHEN** code imports `ActionDispatcher` from `@workflow-engine/core`
- **THEN** the type SHALL describe `(name: string, input: unknown, handler: (input: unknown) => Promise<unknown>, outputSchema: { parse(data: unknown): unknown }) => Promise<unknown>`
