## Context

Event payloads flow through the system unchecked at runtime. Zod schemas are defined in `defineWorkflow` and carried in `WorkflowConfig.events` as `Record<string, z.ZodType>`, but are only used for compile-time type inference. The single emit chokepoint is `ContextFactory#createAndEnqueue` in `packages/runtime/src/context/index.ts`.

Current emit flow:

```
ctx.emit(type, payload)
  → ContextFactory#createAndEnqueue(type, payload, ...)
    → new Event { payload }       ← raw, unvalidated
    → queue.enqueue(event)
```

## Goals / Non-Goals

**Goals:**

- Validate every event payload against its Zod schema before enqueuing
- Use parsed output as the event payload (transforms, defaults, stripping applied)
- Reject unknown event types (no schema = no emit)
- Surface validation failures as HTTP 422 at the trigger boundary with structured, non-Zod error details
- Introduce a `PayloadValidationError` for internal error handling and logging
- Refactor test `ContextFactory` construction to use a factory helper with defaults

**Non-Goals:**

- Changing the `defineWorkflow` API or SDK package
- Adding opt-in/opt-out validation per action or trigger
- Modifying the `EventQueue` interface or storage format
- Exposing Zod internals in HTTP responses

## Decisions

### 1. Validation in `ContextFactory#createAndEnqueue`

Validate at the single chokepoint rather than in individual emit closures or at the HTTP layer.

```
ctx.emit(type, payload)
  → ContextFactory#createAndEnqueue(type, payload, ...)
    → schema = schemas[type]      ← lookup
    → schema not found?           → throw PayloadValidationError
    → parsed = schema.parse(payload)  ← validate + transform
    → new Event { payload: parsed }   ← clean data
    → queue.enqueue(event)
```

**Alternative considered**: Validate in the HTTP middleware before calling `ctx.emit()`. Rejected because it only covers the trigger boundary, not action-to-action emits.

### 2. Structural typing for schema interface

`ContextFactory` accepts `Record<string, { parse(data: unknown): unknown }>` rather than importing `z.ZodType` directly. This keeps the runtime package decoupled from Zod — any object with a `.parse()` method works.

**Alternative considered**: Import `z.ZodType` directly. Rejected because it couples the runtime to a specific validation library for no practical benefit.

### 3. `PayloadValidationError` with two faces

A custom error class that carries structured validation details internally but presents a sanitized view at the HTTP boundary.

```
PayloadValidationError
├── eventType: string
├── issues: { path: string; message: string }[]
├── message: string (human-readable summary)
└── cause: Error (original error from .parse(), for logging)
```

The constructor accepts `eventType`, `issues`, and `cause`. For unknown event types, `issues` is empty and the message indicates the event type is not defined.

**Alternative considered**: Re-throw the raw `ZodError`. Rejected because it leaks Zod internals and doesn't carry the event type context.

### 4. HTTP 422 for validation failures

The HTTP trigger middleware catches `PayloadValidationError` and returns:

```json
{
  "error": "payload_validation_failed",
  "event": "order.received",
  "issues": [
    { "path": "monitor", "message": "Required" },
    { "path": "stamp", "message": "Expected number, received string" }
  ]
}
```

422 (Unprocessable Entity) because the JSON is syntactically valid (not 400) but semantically invalid. The existing 400 response for unparseable JSON remains unchanged.

### 5. Schemas passed via `ContextFactory` constructor

`ContextFactory` constructor gains a `schemas` parameter. In `main.ts`, `config.events` (from `WorkflowConfig`) is passed through directly — Zod schemas satisfy the structural type.

### 6. Test factory helper with defaults

A `createTestFactory()` helper replaces direct `new ContextFactory(...)` calls in tests. All parameters have sensible defaults:

```typescript
function createTestFactory(overrides?: {
  queue?: EventQueue;
  schemas?: Record<string, { parse(data: unknown): unknown }>;
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  logger?: Logger;
}): ContextFactory
```

The default schemas use a passthrough `{ parse: (d) => d }` for common test event types, so tests that don't care about validation still work without noise.

## Risks / Trade-offs

**Dispatch re-validates the same payload N times** → Accepted. The cost is negligible for typical fan-out sizes, and the code stays simple with no special cases.

**All existing tests need schema awareness** → Mitigated by the `createTestFactory()` helper with passthrough defaults. Most tests won't change their assertions.

**Unknown event types throw instead of passing through** → This is intentional and matches compile-time safety, but could surface issues if event types are dynamically generated. Not a current pattern in the codebase.

**`PayloadValidationError` construction requires mapping from library-specific errors** → The mapping from `ZodError.issues` to `{ path, message }[]` is straightforward (join `issue.path` with `.`, take `issue.message`). Contained to one place.
