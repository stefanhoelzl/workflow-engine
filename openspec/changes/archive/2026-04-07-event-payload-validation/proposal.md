## Why

Zod schemas are already defined for every event in `defineWorkflow`, but they are only used for compile-time type inference. Malformed payloads pass through the system unchecked, reaching actions as-is. Adding runtime validation at the emit boundary catches bad data early, prevents corrupted events from propagating through the pipeline, and gives callers actionable error messages.

## What Changes

- Validate event payloads against their Zod schema in `ContextFactory#createAndEnqueue` before enqueuing
- Use the parsed (transformed) output as the event payload, so actions receive clean, normalized data
- Throw a `PayloadValidationError` on invalid payloads or unknown event types, preventing the event from being enqueued
- Return HTTP 422 from the trigger middleware when payload validation fails, with structured error details (event type, issues as `{ path, message }[]`) that do not leak Zod internals
- Refactor `ContextFactory` construction in tests to use a factory helper with sensible defaults

## Capabilities

### New Capabilities

- `payload-validation`: Runtime validation of event payloads against Zod schemas at every emit point, including the `PayloadValidationError` type and HTTP 422 response handling

### Modified Capabilities

- `events`: Remove the "compile-time only validation" requirement, replacing it with runtime validation semantics
- `context`: `ContextFactory` accepts a schemas map (`Record<string, { parse(data: unknown): unknown }>`) and validates in `#createAndEnqueue`

## Impact

- `packages/runtime/src/context/index.ts`: `ContextFactory` constructor gains a `schemas` parameter; `#createAndEnqueue` calls `schema.parse(payload)` before enqueuing
- `packages/runtime/src/triggers/http.ts`: Middleware catches `PayloadValidationError` and returns 422
- `packages/runtime/src/main.ts`: Passes `config.events` to `ContextFactory`
- `packages/runtime/src/context/context.test.ts`: All tests updated to use a factory helper with default schemas
- `packages/runtime/src/integration.test.ts`: Updated to pass schemas
- No changes to the SDK package or `defineWorkflow` API
- No changes to the `EventQueue` interface or queue storage
