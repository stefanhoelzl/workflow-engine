## Context

Workflow authors currently define triggers and actions as untyped plain objects (`Action`, `HttpTriggerDefinition`) with `payload: unknown`. Wiring happens imperatively in `main.ts`. The runtime package has no public API (`index.ts` exports nothing).

The SDK package introduces a single `defineWorkflow` function that replaces both the type definitions and the wiring with a single declarative object. The runtime consumes the resulting `WorkflowConfig` to set up its existing registry, scheduler, and dispatcher.

Future work (out of scope) will bundle workflow definitions for execution in isolated-vm sandboxes, where the engine reads wiring without executing user code.

## Goals / Non-Goals

**Goals:**
- Type-safe workflow authoring: event schemas (Zod), trigger→event wiring, action→event subscriptions, typed env/emit all checked at compile time
- Single entry point: one `defineWorkflow` function (exports `defineWorkflow` + `WorkflowConfig` type only)
- Runtime integration: `WorkflowConfig` output consumed by existing `main.ts` wiring
- Migrate `sample.ts` to the SDK API as proof of concept

**Non-Goals:**
- Sandbox/bridge/isolated-vm integration (future)
- Build tooling / Vite plugin for producing workflow bundles (future)
- Manifest serialization / JSON Schema extraction (future)
- Multiple workflow support (single workflow per definition for now)
- SystemError built-in event (can be added later without breaking changes)

## Decisions

### 1. Single declarative object over builder DSL

The SDK uses `defineWorkflow({ events, triggers, actions })` instead of a chainable builder (`workflow().trigger().on()`).

**Why:** A single object literal enables TypeScript to infer event keys from the `events` map and constrain `triggers.*.event` and `actions.*.on` to only valid keys. Cross-referencing between sibling properties is natural in an object literal but requires complex generic threading in a builder chain. The object shape also maps directly to a future JSON manifest.

**Alternatives considered:**
- Builder DSL (`workflow().trigger().on().emits()`): More ergonomic for small workflows but harder to type cross-references and further from the serialization target.
- Separate `defineEvent` + `defineAction` + `workflow()` composition: Too many concepts; the object approach captures everything in one place.

### 2. Event keys as event type strings

Events are keyed by their type string directly: `events: { 'cronitor.webhook': z.object({...}) }`.

**Why:** Eliminates the need for a `defineEvent` helper. The key is both the local reference (for type-checking cross-references) and the runtime event type string. No mapping layer needed.

**Alternatives considered:**
- `defineEvent(name, schema)` as separate step: Adds indirection; the key→name mapping is unnecessary when they're the same string.
- Separate local key vs event type: More flexible but adds complexity without a current use case.

### 3. Action naming from object keys

Action names are derived from the keys in the `actions` object: `actions: { notifyCronitor: { ... } }`.

**Why:** Object keys are already unique identifiers. No need for `fn.name` derivation (fragile with minification) or explicit `name` fields. The key appears in the manifest and is used for `targetAction` routing.

### 4. Per-action `env` and `emits` declarations

Actions declare their environment variable requirements (`env: ['VAR_A', 'VAR_B']`) and emitted events (`emits: ['event.type']`) alongside the handler.

**Why:** These are per-action concerns, not workflow-level. `env` enables the future sandbox to expose only declared variables (least privilege). `emits` enables TypeScript to type `ctx.emit()` — omitting it types emit as `never` (compile-time guard against accidental emission).

### 5. Trigger type discriminant for extensibility

Triggers include a `type` field (`type: 'http'`) to support future trigger types (cron, SQS, etc.) with different option shapes.

**Why:** Discriminated union on `type` lets TypeScript narrow the options type per trigger kind. The `event` field is always present since every trigger emits exactly one event. HTTP trigger defaults (`method: 'POST'`, `response: { status: 200, body: '' }`) are applied by the runtime's `HttpTriggerRegistry.register()`, not the SDK — the SDK passes trigger definitions through as-is.

### 6. Raw TypeScript exports, no build step

The SDK package exports `.ts` files directly via `package.json` exports. No compilation to `.js` + `.d.ts`.

**Why:** The consumer (runtime package) builds with Vite which handles TypeScript natively. Avoiding a build step simplifies the monorepo — no build coordination, no stale artifacts. Zod is a direct dependency (not peer) since Vite deduplicates it during bundling.

### 7. WorkflowConfig as plain data consumed by runtime

`defineWorkflow` returns a `WorkflowConfig` containing arrays/maps of triggers, event schemas, and action definitions (including handler functions). Actions carry resolved event definitions (`on: { name, schema }`) so the runtime has both the event name and Zod schema without additional lookups. The runtime's `main.ts` reads this config to populate `HttpTriggerRegistry`, create `Action[]`, and start the `Scheduler`. At the boundary, the runtime maps its internal `Event` (with `type` field) to the SDK's `EventDefinition` (with `name` field).

**Why:** Keeps the SDK decoupled from runtime internals. The SDK defines the authoring contract; the runtime decides how to wire it. No `createEngine` helper — the runtime remains in control.

**Sequence: workflow definition → runtime wiring**

```
defineWorkflow({ events, triggers, actions })
         │
         ▼
    WorkflowConfig
    ┌──────────────────────────────────────┐
    │ events: Record<string, ZodSchema>    │
    │ triggers: TriggerInput<string>[]     │
    │ actions: ActionConfig[]              │
    │   on: { name, schema }  ◄── resolved │
    └─────────┬────────────────────────────┘
              │
              ▼  main.ts reads config
    ┌──────────────────────────────────────┐
    │ for each trigger:                    │
    │   registry.register(trigger)         │
    │   (registry applies defaults)        │
    │                                      │
    │ for each action:                     │
    │   create Action { name, match,       │
    │     handler } from ActionConfig      │
    │   handler maps event.type → event.   │
    │     name at the SDK/runtime boundary │
    │                                      │
    │ actions.push(dispatchAction)         │
    │ scheduler = new Scheduler(...)       │
    │ scheduler.start()                    │
    └──────────────────────────────────────┘
```

## Risks / Trade-offs

**[Risk] TypeScript discriminated union inference may not flow handler ctx type from sibling `on` field** → Mitigation: Spike the type inference early (first task). If inference doesn't work, fall back to a helper function per action that connects event to handler. The runtime behavior is unaffected either way.

**[Risk] Zod as direct dependency increases bundle size for future sandboxed workflows** → Mitigation: Acceptable for now. In Option D architecture, Zod runs inside the sandbox alongside user code. Tree-shaking in Vite will remove unused Zod features.

**[Risk] Raw `.ts` exports may cause issues with tools expecting `.js`** → Mitigation: pnpm workspace resolution + Vite's TypeScript handling make this work. If issues arise, add a simple `tsc --emitDeclarationOnly` step.

**[Trade-off] Single workflow per `defineWorkflow` call** → Simplifies types significantly. Multiple workflows can be supported later by calling `defineWorkflow` multiple times or adding a `defineWorkflows` (plural) variant.
