## Context

The workflow engine uses four primitives: Trigger -> Event -> Action -> Event. Currently, HTTP triggers parse the JSON body and pass it as the event payload. The trigger definition references a separately defined event via an `event` field, and the same `WorkflowBuilder<E>` type pool is shared by both trigger and action events.

In practice, trigger events and action events are never shared — triggers are transport-specific (HTTP context like headers/path doesn't apply to action-emitted events). The current flat model forces all events through the same schema shape and provides no access to HTTP request metadata.

The SDK builder (`packages/sdk/src/index.ts`) uses a single generic `WorkflowBuilder<E>` with chained `.event()`, `.trigger()`, `.action()` methods. The runtime HTTP middleware (`packages/runtime/src/triggers/http.ts`) passes only the parsed body to `source.create()`. The manifest links triggers to events via the `event` field.

## Goals / Non-Goals

**Goals:**
- HTTP trigger events carry full request context: `{ body, headers, path, method }`
- Triggers implicitly define their own events (trigger name = event name)
- Phase-typed builder enforces definition order: triggers -> events -> actions
- Type-safe separation: actions can listen to any event, but can only emit action events
- Unique event names enforced at compile-time across both pools
- `http()` helper generates trigger config + wrapped schema from a body schema
- Manifest format updated to drop `event` field from triggers

**Non-Goals:**
- Custom body parsers (future work — always JSON-parse for now)
- Non-HTTP trigger types (mail, websocket, cron — future work, but `http()` establishes the pattern)
- Query string parsing (the path includes the raw query string)
- Header filtering or sanitization
- Changes to the sandbox boundary (actions still receive `ctx.event.payload` — just a different shape)

## Decisions

### 1. Trigger-owned events with two type pools

**Decision:** Split `WorkflowBuilder<E>` into `WorkflowBuilder<T, E>` where `T` = trigger events, `E` = action events.

- `on` accepts `keyof (T & E)` — actions can listen to both pools
- `emits` accepts `keyof E` only — actions cannot emit trigger events
- `ctx.event.payload` is typed from the appropriate pool via `z.infer<(T & E)[K]>`

**Why over single pool:** Different trigger types have fundamentally different payload shapes (HTTP has headers/path, future mail has from/to/subject). Mixing them in one pool with a uniform schema doesn't model reality. Separating pools also prevents the nonsensical pattern of an action emitting an HTTP-shaped event.

**Alternative considered:** Keep single `E` pool, add an `httpPayload(bodySchema)` wrapper. Rejected because it doesn't enforce the emit restriction and conflates two conceptually different event sources.

### 2. Phase-typed builder

**Decision:** The builder progresses through phases that restrict which methods are available:

```
createWorkflow() -> TriggerPhase<{}>
  .trigger()     -> TriggerPhase<T>       [trigger, event, action, compile]
  .event()       -> EventPhase<T, E>      [event, action, compile]
  .action()      -> ActionPhase<T, E>     [action, compile]
  .compile()     -> CompileOutput
```

Phases can be skipped (zero triggers or zero action events are valid). The underlying implementation is a single class — phases are different interface projections.

**Why over unrestricted builder:** Enforces a natural definition order. Prevents defining triggers after actions (which would be confusing since the trigger event wouldn't be available to earlier actions). Minimal implementation cost since it's just type-level — the runtime class doesn't change structurally.

### 3. `http()` helper function

**Decision:** Export `http(config)` from the SDK. It accepts `{ path, method?, body?, response? }` and returns a `TriggerDef<S>` carrying the trigger config and the generated schema.

When `body` is provided, the schema wraps it: `z.object({ body: <schema>, headers: z.record(z.string(), z.string()), path: z.string(), method: z.string() })`.

When `body` is omitted, it defaults to `z.unknown()`.

**Why `http()` not `httpTrigger()`:** The `.trigger()` method already establishes context — `httpTrigger()` stutters. `http()` is concise and sets up the naming pattern for future trigger types (`cron()`, `mail()`, `websocket()`).

### 4. Always JSON-parse body, 422 on failure

**Decision:** The HTTP middleware always attempts to JSON-parse the request body. Parse failure returns 422 (consistent with existing `PayloadValidationError` responses). The parsed body (or `z.unknown()` if no body schema) is validated against the event schema.

**Why not conditional parsing:** Deriving parse behavior from the schema (checking if `body` type is `"string"` in JSON schema) was considered but rejected in favor of always JSON-parsing now with custom parsers as future work. This keeps the middleware simple and the behavior predictable.

### 5. Unique name enforcement via conditional `never`

**Decision:** Use the TypeScript pattern `Name extends keyof T | keyof E ? never : Name` to reject duplicate event names at compile-time.

```typescript
trigger<Name extends string>(
  name: Name extends keyof T ? never : Name,
  ...
): TriggerPhase<T & Record<Name, S>>;

event<Name extends string>(
  name: Name extends keyof T | keyof E ? never : Name,
  ...
): EventPhase<T, E & Record<Name, S>>;
```

**Why not runtime check:** Compile-time is strictly better — catches errors earlier, no runtime cost.

### 6. Manifest: trigger name = event name, drop `event` field

**Decision:** Triggers no longer carry an `event` field in the manifest. The runtime resolves the event by using the trigger's `name` to look up the event in the `events` array. Trigger-owned events appear in `events[]` with their full HTTP-wrapped JSON schema.

**Why in `events[]` not embedded in trigger:** Keeps the runtime's schema loading uniform — it iterates `events[]` and builds a schema map regardless of event source. The trigger registry just needs `name`, `path`, `method`, `response`.

### 7. Headers as `Record<string, string>`

**Decision:** Forward all HTTP headers as a flat `Record<string, string>`. Multi-value headers are joined with `, ` per HTTP spec (Hono's `Headers` iterator does this). No headers are filtered or stripped.

**Why all headers:** Workflows may need any header (webhook signatures, content negotiation, auth tokens). Security is the deployer's responsibility. The `Set-Cookie` multi-value edge case is acceptable in a workflow engine context.

## Risks / Trade-offs

**[Breaking change across all workflows]** Every existing workflow must migrate event schemas and action handler payload access (`payload.x` -> `payload.body.x`).
-> Mitigation: Only one workflow exists (cronitor). Migration is mechanical and part of this change.

**[Type complexity increase]** Two generic params + phase types + conditional `never` adds TypeScript complexity.
-> Mitigation: Complexity is in the builder interfaces, not the runtime implementation. Workflow authors see a simpler API (fewer concepts — no separate event for triggers).

**[Multi-value header data loss]** `Set-Cookie` values containing commas are ambiguous when joined with `, `.
-> Mitigation: Acceptable for workflow engine use case. If needed later, switch to `Record<string, string[]>`.

**[`z.unknown()` default body is permissive]** When body schema is omitted, any JSON body passes validation.
-> Mitigation: This is intentional — passthrough triggers that only care about headers/path. The schema is explicit about accepting unknown.

## Cross-Component Flow

```
HTTP Request: POST /webhooks/cronitor?source=api
  Headers: { content-type: application/json, x-signature: abc }
  Body: { "id": "123", "type": "ALERT" }
        │
        ▼
┌─ HTTP Trigger Middleware ─────────────────────────────┐
│ 1. Strip /webhooks/ prefix -> "cronitor"              │
│ 2. Registry lookup("cronitor", "POST") -> trigger def │
│ 3. JSON parse body -> { id: "123", type: "ALERT" }   │
│    (failure -> 422)                                   │
│ 4. Construct payload:                                 │
│    {                                                  │
│      body: { id: "123", type: "ALERT" },              │
│      headers: { content-type: ..., x-signature: ... },│
│      path: "/webhooks/cronitor?source=api",           │
│      method: "POST"                                   │
│    }                                                  │
│ 5. source.create("webhook.cronitor", payload, name)   │
│    (schema validation -> 422 on failure)              │
│ 6. Return configured response (202)                   │
└───────────────────────────────────────────────────────┘
        │
        ▼
┌─ Event Bus ───────────────────────────────────────────┐
│ RuntimeEvent {                                        │
│   type: "webhook.cronitor",                           │
│   payload: { body, headers, path, method },           │
│   sourceType: "trigger",                              │
│   sourceName: "webhook.cronitor",                     │
│   ...                                                 │
│ }                                                     │
└───────────────────────────────────────────────────────┘
        │
        ▼
┌─ Scheduler -> Action ─────────────────────────────────┐
│ ctx.event.payload.body.id         // "123"            │
│ ctx.event.payload.headers["x-signature"]  // "abc"    │
│ ctx.event.payload.path    // "/webhooks/cronitor?..."  │
│ ctx.event.payload.method  // "POST"                   │
└───────────────────────────────────────────────────────┘
```
