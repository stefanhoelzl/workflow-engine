## Context

Currently, `ContextFactory.httpTrigger()` generates a `corr_<UUID>` correlation ID and passes it to `eventFactory.create(type, payload, correlationId)`. The factory assigns it verbatim. There is exactly one call site for `create()`, and the HTTP trigger handler calls `emit()` exactly once per invocation. `derive()` and `fork()` already inherit the correlation ID from the parent event — they are unaffected.

```
HTTP Request
    │
    ▼
ContextFactory.httpTrigger()
    │  correlationId = corr_<UUID>     ← generated here (current)
    │
    ▼
emit() callback
    │
    ▼
eventFactory.create(type, payload, correlationId)
    │  id = evt_<UUID>                 ← generated here
    │  correlationId = <passed in>     ← just assigned
    ▼
RuntimeEvent
```

After the change:

```
HTTP Request
    │
    ▼
ContextFactory.httpTrigger()
    │
    ▼
emit() callback
    │
    ▼
eventFactory.create(type, payload)
    │  id = evt_<UUID>                 ← generated here
    │  correlationId = corr_<UUID>     ← generated here (new)
    ▼
RuntimeEvent
```

## Goals / Non-Goals

**Goals:**
- Remove the `correlationId` parameter from `eventFactory.create()`
- Generate `corr_<UUID>` inside `create()`, consistent with `evt_<UUID>` generation
- Simplify `ContextFactory.httpTrigger()` by removing correlation ID plumbing

**Non-Goals:**
- Supporting external/caller-provided correlation IDs (e.g., from request headers)
- Changing `derive()` or `fork()` behavior (they inherit from parent, unchanged)
- Injecting a UUID generator for deterministic testing

## Decisions

**1. `create()` owns correlation ID generation**

The factory already generates `evt_<UUID>` for event IDs. Adding `corr_<UUID>` generation is the same pattern. This makes the factory the single source of truth for all event identity fields.

Alternative considered: optional parameter with auto-generation as default. Rejected — there is no current or planned need for caller-provided correlation IDs. If external request tracing is needed later, it should be a separate field (e.g., `externalRequestId`), not overloading correlation ID.

**2. No UUID generator injection for tests**

Tests assert that the correlation ID is set (truthy), not exact values. The integration test already uses `expect(...).toMatch(CORR_PREFIX)`. This is sufficient. Adding a generator parameter would add API surface purely for testing.

## Risks / Trade-offs

**[Minimal] No external correlation ID support** → If needed later, add an `externalRequestId` field to RuntimeEvent rather than re-adding the parameter. This is a separate concern from internal event chain correlation.
