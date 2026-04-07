## Context

`ActionContext` currently provides `event` (readonly), `emit()`, and `fetch()`. All three follow the same constructor-injection pattern: `ContextFactory` holds infrastructure dependencies and threads them into each `ActionContext` it creates.

Actions that need configuration (e.g. the Cronitor→Nextcloud sample) currently read `process.env` at module scope via a `requireEnv()` helper and close over the values. This works but couples action definitions to the global environment and offers no injection point for tests or future sandboxing.

## Goals / Non-Goals

**Goals:**
- Add `env` as a readonly property on `ActionContext` exposing `Record<string, string | undefined>`
- Follow the constructor-injection pattern: `ContextFactory` accepts an env record and passes it through
- Migrate sample actions from module-scope env closures to `ctx.env.*`

**Non-Goals:**
- Per-action env filtering or declaration (actions see the full env record)
- Validation of env vars at startup or at context creation time
- Adding env to `HttpTriggerContext` or the `Context` interface
- Env var policy enforcement or allowlisting (future sandbox concern)

## Decisions

### 1. Public readonly property, not a private field with accessor method

`env` is exposed as `readonly env: Record<string, string | undefined>` directly on `ActionContext`, unlike `fetch` which uses a private `#fetch` field wrapped by a public method.

**Why:** `fetch` needs a method wrapper to preserve the calling convention (`ctx.fetch(url, init)`). `env` is plain data — a property access is the natural API. No method delegation needed.

### 2. ContextFactory accepts env as a third constructor parameter

`ContextFactory` takes `(queue, fetch, env)` and stores `env` as `#env`, threading it into every `ActionContext`.

**Why over passing env directly to ActionContext:** Same reasoning as `fetch` — centralizes wiring in the factory. `factory.action(event)` stays unchanged from the caller's perspective. The scheduler doesn't need to know about env.

**Alternative considered:** Accepting `process.env` directly in `ActionContext` constructor. Rejected because it would require every context-creation site to supply env, breaking the factory abstraction.

### 3. Full process.env pass-through, no filtering

The entire env record is passed through without filtering to a declared subset.

**Why:** Keeps the design simple. Per-action env isolation is a sandbox concern — when V8 isolates land, the sandbox layer can restrict which env vars are visible. Adding filtering now would be speculative complexity.

### 4. ActionContext only — not on Context interface or HttpTriggerContext

`env` is added only to `ActionContext`, matching the `fetch` precedent.

**Why:** HTTP triggers handle inbound requests; they don't need environment configuration. Keeping the `Context` interface minimal avoids forcing unnecessary capabilities onto trigger contexts.

## Risks / Trade-offs

**[Risk] Actions can read any env var** — No isolation between actions sharing the same process.
→ *Mitigation:* Acceptable pre-sandbox. The V8 isolate boundary will restrict env access per-action. The injection point established here is the hook for that restriction.

**[Trade-off] No validation of expected env vars** — A missing env var surfaces as `undefined` at runtime, not at startup.
→ *Mitigation:* This is a deliberate choice. Actions are responsible for handling missing config. The `requireEnv` pattern can be replicated inside action handlers if desired.
