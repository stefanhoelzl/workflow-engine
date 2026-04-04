## Context

`ActionContext` currently provides `event` (readonly) and `emit()`. Actions running in the main Node.js process can use `globalThis.fetch`, but when V8 isolates land (per sandbox spec), global APIs will be unavailable. We need to establish `ctx.fetch()` as the canonical way for actions to make HTTP requests before authors start relying on the global.

The existing pattern is constructor injection: `emit` is passed as a function into `ActionContext`, and `ContextFactory` wires it to the queue. `fetch` follows the same pattern.

## Goals / Non-Goals

**Goals:**
- Add `fetch(url, init?)` to `ActionContext` returning native `Response`
- Follow the constructor injection pattern established by `emit`
- Accept a fetch function in `ContextFactory` constructor for testability
- Update the context spec to cover the new method

**Non-Goals:**
- URL allowlisting, rate limiting, or policy enforcement (future sandbox concern)
- Observability/logging wrapper around fetch (can be layered later via the injection point)
- Simplified or serialized response objects (no sandbox boundary yet)
- Adding fetch to `HttpTriggerContext` or the `Context` interface
- Modifying the sandbox spec

## Decisions

### 1. Constructor injection over direct global access

`ActionContext` receives a fetch function as a constructor parameter, stored as `#fetch`. The public `fetch()` method delegates to it.

**Why over global access:** Matches the `emit` pattern. Makes unit tests trivial (pass `vi.fn()`). Gives the future sandbox a clean interception point without changing ActionContext's public API.

### 2. ContextFactory accepts fetch as a second constructor parameter

`ContextFactory` takes `(queue, fetch)` and threads the fetch function into every `ActionContext` it creates.

**Why on the factory:** Centralizes wiring. Callers constructing a factory already pass infrastructure dependencies (queue). Adding fetch here means action code and scheduler code don't change at all.

**Alternative considered:** Passing fetch only at the `ActionContext` level. Rejected because it would require the scheduler or its callers to know about fetch, breaking the current `factory.action(event)` abstraction.

### 3. Standard fetch signature with native Response

`ctx.fetch(url: string | URL, init?: RequestInit): Promise<Response>` — same signature as the global `fetch`.

**Why native Response:** No sandbox boundary exists yet, so there's nothing to serialize across. When the isolate bridge arrives, it can translate Response into a JSON-serializable form at that layer. Using native types now avoids inventing a custom response API that may not match what the sandbox needs.

### 4. ActionContext only — not on Context interface

`fetch` is added only to `ActionContext`, not to the shared `Context` interface or `HttpTriggerContext`.

**Why:** HTTP triggers handle inbound requests; they don't need outbound fetch. Keeping the `Context` interface minimal (emit-only) avoids forcing unnecessary capabilities onto trigger contexts.

## Risks / Trade-offs

**[Risk] API divergence when sandbox lands** — The sandbox will need a synchronous or bridged fetch that returns serialized data, not a native `Response`. The `ctx.fetch()` signature may need to change.
→ *Mitigation:* The injection point means the sandbox can provide a different implementation behind the same `fetch` call. If Response serialization is needed, it can be done in the injected function without changing ActionContext.

**[Risk] No timeout on fetch calls** — A fetch that hangs will block the action until the scheduler's 30s timeout kills it.
→ *Mitigation:* Acceptable for now. The 30s execution timeout is the backstop. Per-request timeouts can be added to the injected function later without API changes.
