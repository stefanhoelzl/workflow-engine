## Context

Actions currently declare environment variable needs via `env: string[]` (names only) and receive the entire `process.env` at runtime through `createActionContext`. The Vite plugin already evaluates workflow modules at build time (importing them in `generateBundle` to call `.compile()`), which creates a natural point for resolving env values without additional build infrastructure.

The existing build pipeline produces per-workflow `manifest.json` + `actions.js`. The manifest already captures action env declarations as `string[]`. This design extends that to carry resolved values.

## Goals / Non-Goals

**Goals:**
- Workflow authors define config values (literals and env captures) in the SDK builder
- Values resolve at build time and bake into the manifest
- Actions receive only their declared env, not the full process environment
- Type-safe access to env keys in action handlers

**Non-Goals:**
- Secrets management (out of scope, future work)
- Runtime config updates or hot-reloading of env values
- Structured config beyond flat string key-value pairs
- Per-environment config files (`.env` files, YAML, etc.)

## Decisions

### 1. `env()` returns a Symbol-branded marker resolved eagerly by the builder

`env()` returns an `EnvRef` object branded with a `Symbol("env")`. The builder's `.env()` and `.action()` methods resolve markers immediately from `process.env` when called, not deferred to `compile()`.

**Why:** Since the Vite plugin imports the module to call `.compile()`, module evaluation (where `.env()` runs) already happens at build time. Eager resolution means the builder's internal state is always resolved strings — `compile()` just serializes them. A Symbol brand is unforgeable, preventing accidental marker-like objects from being treated as env refs.

**Alternatives considered:**
- Vite plugin AST transform to inline `env()` calls → unnecessary complexity; the module is already evaluated at build time
- Lazy resolution in `compile()` → would work but makes builder state inconsistent (mix of strings and markers)

### 2. Workflow-level `.env()` with per-action merge (action wins)

Config is declared at two levels: workflow-wide via `.env({})` and per-action via `env: {}`. All workflow env is available to every action. Action env merges on top, overriding on key conflict.

**Why:** Shared config (like a base URL) shouldn't be repeated in every action. Per-action overrides handle cases where one action needs a different value for the same key.

**Alternatives considered:**
- Action-only env (no workflow level) → too much repetition for shared config
- Workflow-only env (no per-action) → insufficient granularity

### 3. Manifest stores pre-merged `Record<string, string>` per action

`compile()` merges workflow + action env and emits a flat `Record<string, string>` per action in `CompileOutput`. The manifest captures these merged values directly.

**Why:** The runtime doesn't need to know about the workflow/action distinction — it just needs the final env per action. Merging at compile time keeps the runtime simple.

### 4. Per-action env injection replaces global `process.env` passthrough

The runtime loader reads `env: Record<string, string>` from each action's manifest entry and attaches it to the `Action` object. The scheduler passes the action's env when creating `ActionContext`, instead of a shared `process.env`.

**Why:** Eliminates accidental access to unrelated env vars. Each action sees exactly what it declared.

### 5. `env()` no-arg infers key name from the object property

```typescript
.env({ NEXTCLOUD_URL: env() })
// equivalent to:
.env({ NEXTCLOUD_URL: env("NEXTCLOUD_URL") })
```

The builder iterates `Object.entries()` of the env object. For `EnvRef` markers with `name === undefined`, the object key is used as the env var name.

**Why:** Reduces boilerplate — the common case is that the env var name matches the config key.

## Risks / Trade-offs

**Build-time coupling** — Env values are frozen at build time. Changing a config value requires a rebuild. → Acceptable for this use case; secrets (which change more often) are out of scope and will use a runtime mechanism later.

**No validation that all env vars are provided** — If `env()` is used without `{ default }` and the var is missing, the build fails immediately with a clear error. → This is the desired behavior.

**Manifest contains plaintext config** — Resolved values (including any captured env vars) are stored in `manifest.json` as plaintext. → Acceptable since secrets are out of scope. When secrets are added later, they will not go through this mechanism.

**TypeScript complexity** — The builder needs a second generic parameter to track accumulated env keys across `.env()` and `.action()` calls. → Manageable; the builder already tracks event definitions via generics.

## Data Flow

```
BUILD TIME (Vite plugin generateBundle)
════════════════════════════════════════

  workflow.ts evaluated
       │
       ▼
  createWorkflow()
  .env({ A: env(), B: "literal" })  ──── env() reads process.env["A"]
  .action({ env: { C: env() } })    ──── env() reads process.env["C"]
       │
       ▼
  .compile()
  ├── merges workflow env {A, B} + action env {C}
  └── returns { actions: [{ env: {A: "...", B: "literal", C: "..."} }] }
       │
       ▼
  Vite plugin emits manifest.json
  { "actions": [{ "env": {"A": "val", "B": "literal", "C": "val"} }] }


RUNTIME (loader + scheduler)
════════════════════════════

  loadWorkflow() reads manifest.json
       │
       ▼
  Action { name, on, handler, env: {A, B, C} }
       │
       ▼
  scheduler.executeAction(event, action)
       │
       ▼
  ActionContext(event, emit, fetch, action.env)
       │
       ▼
  handler(ctx) → ctx.env.A, ctx.env.B, ctx.env.C
```
