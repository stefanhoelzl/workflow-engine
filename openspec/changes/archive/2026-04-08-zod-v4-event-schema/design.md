## Context

The `Event` type is a plain TypeScript interface in `event-queue/index.ts`. The `FileSystemEventQueue` duplicates most of it as `StoredEvent` to handle JSON serialization (`Date` → `string`, `undefined` → `null`) plus a `state` field. This results in manual `serializeEvent()`/`deserializeEvent()` functions.

The project uses `exactOptionalPropertyTypes: true`, which means `?: string` and `?: string | undefined` are distinct types. Zod v3's `.optional()` infers `?: T | undefined`, which is incompatible. Zod v4 introduced `exactOptional()` which infers `?: T` — exactly what's needed.

The SDK currently depends on `zod@^3.25.0` and re-exports `z` for workflow authors. The runtime has no direct Zod dependency.

## Goals / Non-Goals

**Goals:**
- Eliminate `StoredEvent` interface and manual serialization/deserialization in `fs-queue.ts`
- Define `Event` as a Zod v4 schema so `StoredEventSchema` can be derived via `.extend({ state })`
- Upgrade Zod to v4 across the project
- Maintain `exactOptionalPropertyTypes` compatibility

**Non-Goals:**
- Changing the shape or semantics of `Event` — the type stays identical
- Adding runtime validation at the `EventQueue` interface boundary — Zod is used for schema definition and disk serialization, not for validating every enqueue/dequeue
- Migrating the SDK's payload validation schemas — they use `z.object()` which works the same in v4

## Decisions

### 1. Upgrade to Zod v4 via `"zod/v4"` import path

Zod v4 is shipped inside the `zod@^3.25.0` package at `zod/v4`. Changing the version specifier to `^4.0.0` and importing from `"zod"` directly gives the v4 API. This is the recommended upgrade path.

**Alternative considered**: Keep v3 and only use v4 in the runtime. Rejected because having two Zod APIs in the same project creates confusion, and v4 is backwards-compatible for the patterns the SDK uses.

### 2. EventSchema in `event-queue/index.ts`

Define `EventSchema` using Zod v4's `z.object()` with `z.exactOptional()` for `targetAction` and `parentEventId`. Export both the schema and the derived type:

```typescript
import { z } from "zod";

const EventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  targetAction: z.exactOptional(z.string()),
  correlationId: z.string(),
  parentEventId: z.exactOptional(z.string()),
  createdAt: z.coerce.date(),
});

type Event = z.infer<typeof EventSchema>;
```

`z.exactOptional()` produces `?: string` (not `?: string | undefined`), matching `exactOptionalPropertyTypes`.

`z.coerce.date()` accepts both `Date` objects and ISO 8601 strings, handling the JSON deserialization case.

### 3. StoredEventSchema in `fs-queue.ts`

```typescript
const StoredEventSchema = EventSchema.extend({
  state: z.enum(["pending", "done", "failed"]),
});
```

- Serialization: `JSON.stringify(event)` — Zod is not involved
- Deserialization: `StoredEventSchema.parse(JSON.parse(content))` — validates and coerces `createdAt` string → `Date`

This replaces `StoredEvent` interface, `serializeEvent()`, and `deserializeEvent()`.

### 4. SDK migration

The SDK imports `z` from `"zod"` (v3 API). After upgrading to `zod@^4.0.0`, the import stays `from "zod"` and gets the v4 API directly. The SDK uses `z.object()`, `z.string()`, `z.enum()`, `z.nullable()` — all of which exist in v4 with the same API.

### 5. EventQueue interface uses `Event` type, not schema

The `EventQueue` interface continues to use the `Event` type (derived from `z.infer`). Queue implementations don't validate events with the schema at the interface boundary — the schema is used only where serialization happens (filesystem queue).

## Risks / Trade-offs

**[Zod v4 breaking changes in SDK]** → The SDK re-exports `z` to workflow authors. If Zod v4 removed or renamed APIs used in workflow definitions, this would break users. → Mitigation: The SDK uses only basic Zod APIs (`z.object`, `z.string`, `z.enum`, `z.nullable`) which are all present in v4.

**[Runtime Zod dependency]** → The runtime gains a new dependency. → Acceptable: Zod is already an indirect dependency via the SDK, and it's used only in `fs-queue.ts` for disk serialization.
