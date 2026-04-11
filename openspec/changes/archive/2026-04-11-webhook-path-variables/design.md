## Context

HTTP triggers currently match incoming requests by exact string equality in `HttpTriggerRegistry.lookup()`. The middleware is a single Hono catch-all route (`/webhooks/*`) that strips the prefix and delegates matching to the registry. The payload shape is `{ body, headers, url, method }`, typed via Zod schemas that flow from the SDK through JSON Schema in the manifest to runtime validation.

Triggers are dynamic — workflows can be registered/unregistered at runtime via `WorkflowRegistry.rebuild()`, which recreates the `HttpTriggerRegistry` each time. This means we cannot rely on Hono's built-in router for per-trigger routes.

## Goals / Non-Goals

**Goals:**
- Support `:param` named segments and `*wildcard` catch-all segments in trigger paths
- Provide compile-time typed `payload.params` inferred from the path string
- Allow optional Zod schema for params runtime validation/coercion
- Maintain backward compatibility — static paths keep working, payload gains `params: {}`

**Non-Goals:**
- Regex constraints on params (e.g., `:id(\d+)`) — can be added later via the optional Zod schema
- Query string parameter extraction — `url` already carries the full URL for manual parsing
- Changing the dynamic trigger registration architecture

## Decisions

### 1. Path matching: URLPattern over Hono router or path-to-regexp

**Decision:** Use the Web Standard `URLPattern` API for path matching inside `HttpTriggerRegistry`.

**Rationale:** Hono's router cannot be used because triggers are dynamically registered and Hono doesn't support route addition after app creation. `URLPattern` is a zero-dependency built-in (Node 22+, project uses Node 24) that supports the same `:param` and `*wildcard` syntax. `path-to-regexp` was considered but adds a dependency for functionality already available natively.

**Alternatives considered:**
- *Hono native routing:* Would require rebuilding the entire Hono app on each workflow registration. Adds complexity for hot-reload and in-flight request handling.
- *path-to-regexp:* Battle-tested but unnecessary external dependency when URLPattern is built-in.
- *Custom regex parser:* Re-invents what URLPattern already provides.

### 2. Matching priority: static paths preferred over parameterized

**Decision:** When both a static path and a parameterized path could match a request, the static path wins.

**Implementation:** The registry sorts triggers so static paths (no `:param` or `*` segments) are checked before parameterized paths. This is a simple partition: iterate static triggers first, then parameterized triggers. The first match wins.

**Rationale:** This matches the behavior of Express, Hono, and other frameworks. It's the most intuitive behavior and nearly zero implementation cost (just ordering the iteration).

### 3. Type inference: template literal types for param names

**Decision:** Infer param names from the path string using TypeScript recursive template literal types. All inferred params are `Record<inferredKeys, string>`.

```typescript
// Extracts "userId" | "postId" from "users/:userId/posts/:postId"
type ExtractParams<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<Rest>
    : T extends `${string}:${infer Param}`
      ? Param
      : T extends `${string}*${infer Param}`
        ? Param
        : never;
```

**Rationale:** This is how Hono and Express v5 handle it. Zero redundancy — the path string is the single source of truth for param names. The path must be a string literal for inference to work, which is the natural usage pattern.

### 4. Optional params Zod schema with compile-time key enforcement

**Decision:** The `http()` helper accepts an optional `params` Zod schema. When provided, TypeScript enforces that the schema's keys match the param names inferred from the path string.

```typescript
function http<P extends string, B extends z.ZodType, Params extends z.ZodType>(config: {
  path: P;
  body?: B;
  params?: Params & KeysMatch<Params, ExtractParams<P>>;
  // ...
})
```

**Rationale:** Inferred string params cover the common case. The optional Zod schema adds validation/coercion (e.g., `z.string().uuid()`) for the advanced case. Compile-time key enforcement catches mismatches between path and schema without runtime cost.

### 5. Payload shape: always include `params`

**Decision:** Every HTTP trigger payload includes `params: Record<string, string>`. Static triggers get `params: {}`.

**Rationale:** Consistent shape means action handlers can always access `payload.params` without checking if it exists. The empty object is cheap and avoids conditional types.

### 6. Manifest format: store param names

**Decision:** Trigger entries in `manifest.json` gain an optional `params: string[]` field listing the extracted param names. When an explicit params Zod schema is provided, its JSON Schema is included in the event schema under the `params` property. When no explicit schema is provided, `params` defaults to `Record<string, string>` in the event schema.

**Rationale:** Param names are extracted from the path at build time by the Vite plugin and stored for runtime validation. The runtime verifies that URLPattern match groups produce the expected keys.

## Cross-component flow

```
Build time (Vite plugin):
  workflow.ts → http({ path: "users/:userId/status" })
    → extract param names ["userId"] from path
    → generate event JSON Schema with params property
    → manifest.json: trigger.params = ["userId"]

Request time:
  POST /webhooks/users/abc123/status
    → httpTriggerMiddleware strips "/webhooks/"
    → HttpTriggerRegistry.lookup("users/abc123/status", "POST")
      → iterate static triggers first (no match)
      → iterate parameterized triggers
      → URLPattern({ pathname: "users/:userId/status" }).exec(...)
      → match → groups: { userId: "abc123" }
    → return { ...trigger, params: { userId: "abc123" } }
    → middleware builds payload { body, headers, url, method, params: { userId: "abc123" } }
    → source.create(trigger.name, payload, trigger.name)
      → validate payload against event schema (including params)
    → return configured response
```

## Risks / Trade-offs

- **[Template literal type complexity]** Recursive template literal types can produce cryptic error messages when the path string is not a literal (e.g., passed as a variable). → *Mitigation:* This is the same trade-off Hono makes. The natural usage pattern (`http({ path: "literal/string" })`) works correctly. Add a type-level fallback to `Record<string, string>` when inference fails.

- **[URLPattern browser compat]** URLPattern is Node 22+ only. → *Mitigation:* Project already uses Node 24 (Dockerfile: `FROM node:24-slim`). No concern.

- **[Linear scan for matching]** The registry iterates all triggers to find a match. → *Mitigation:* Trigger counts are small (tens, not thousands). Linear scan is simpler and more than sufficient. Can be optimized later if needed.

- **[Payload shape change]** Adding `params` to the payload is technically a shape change for existing event schemas. → *Mitigation:* The Zod schema generated by `http()` always includes `params`. Existing persisted events without `params` would fail re-validation, but events are append-only and validated at creation time, not re-read through the schema. The manifest JSON Schema is regenerated on each build.
