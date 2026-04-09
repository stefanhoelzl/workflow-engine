## Context

The workflow engine currently bundles metadata and handler code together. The SDK's `workflow()` builder produces a `WorkflowConfig` via `.build()`, and the runtime dynamically imports these bundles to discover events, triggers, actions, and handler functions. This means inspecting the workflow graph requires executing action code — preventing static analysis and violating security isolation.

The SDK uses Zod v4 which provides built-in `z.toJSONSchema()` and `z.fromJSONSchema()` for lossless schema round-tripping (verified with all current schema patterns: objects, strings, enums, nullable).

## Goals / Non-Goals

**Goals:**
- Enable reading workflow topology (events, triggers, actions, emits, env) from a static JSON file without executing any code
- Produce `actions.js` that contains only handler entry points with no Zod/SDK dependency
- Preserve full TypeScript type inference for `ctx.event.payload`, `ctx.emit()`, and `ctx.env` in action handlers
- Keep the authoring experience simple — single source file per workflow, inline handler definitions

**Non-Goals:**
- Dashboard integration with manifests (follow-up work)
- Cross-workflow event conflict detection (pre-existing issue, not addressed here)
- Lazy action loading (eager startup loading retained)
- Manifest versioning (premature — format is new)

## Decisions

### 1. Single-phase builder replaces phased interfaces

**Decision**: Replace the 4 phased interfaces (`StartPhase`, `EventPhase`, `TriggerPhase`, `ActionPhase`) with a single generic `WorkflowBuilder<E>` interface.

**Rationale**: Since `.action()` now returns a handler function (not `this`), chaining through `.action()` is no longer possible. A single phase with TypeScript generic constraints still enforces that triggers and actions reference defined events. This simplifies the type system while preserving compile-time safety.

**Alternative considered**: Keep multi-phase interfaces with `.action()` as a terminal method. Rejected because it would prevent calling `.action()` multiple times.

### 2. Vite transform hook for clean actions.js

**Decision**: Use a Vite `transform` hook to strip `.action()` wrappers in the actions.js build pass, converting `export const X = workflow.action({handler: fn})` to `export const X = fn`. Tree-shaking then eliminates SDK/Zod as dead code.

**Rationale**: Handlers defined inline in `.action()` create a dependency chain through the builder to the SDK/Zod. The bundler cannot know that `.action()` is a pass-through without executing it. The transform hook breaks this chain at the source level, enabling standard tree-shaking. Module-level imports, constants, and helpers used by handlers are preserved because they're still referenced after the transform.

**Alternatives considered**:
- *Standalone handler functions*: Breaks `ctx` type inference — rejected by design requirement
- *`Function.toString()` serialization*: Breaks when handlers reference module-level variables or imports
- *Accept SDK/Zod in actions.js*: Defeats security isolation goal

### 3. Two-pass build per workflow

**Decision**: The Vite plugin performs two passes per workflow file:
1. **Manifest pass**: Import the full module in Node, call `builder.compile()`, match handler references to named exports via reference equality, write `manifest.json`
2. **Actions pass**: Apply the transform hook, let Vite bundle with tree-shaking, write `actions.js`

**Rationale**: The manifest pass needs the full module to call `.compile()` and resolve action names. The actions pass needs the transform to produce clean output. These are fundamentally different operations that cannot be combined.

```
  WORKFLOW BUILD SEQUENCE
  ════════════════════════════════════════════════════

  cronitor.ts ──┬── Pass 1: import → .compile() ──── manifest.json
                │   (full module execution)           - events + JSON Schema
                │   - match handler refs to exports   - triggers
                │   - z.toJSONSchema() for schemas    - actions (name, handler, on, emits, env)
                │                                     - module: "./actions.js"
                │
                └── Pass 2: transform → bundle ────── actions.js
                    (strip .action() wrappers)        - named function exports
                    (tree-shake SDK/Zod)              - no Zod/SDK dependency
```

### 4. Action name resolution from export variable names

**Decision**: Action names are derived from the named export variable name by the Vite plugin. An optional `name` parameter on `.action()` overrides this. The manifest stores both `name` (identity) and `handler` (export name).

**Rationale**: Eliminates name duplication between the string argument and the export name. The plugin resolves names by matching handler function references between `compile()` output and module named exports.

### 5. JSON Schema for event schemas in manifest

**Decision**: Event schemas are stored as JSON Schema in `manifest.json`, converted at build time via `z.toJSONSchema()`. At runtime, schemas are reconstructed via `z.fromJSONSchema()` for payload validation.

**Rationale**: JSON Schema is a widely supported, language-agnostic format. Zod v4 provides native support for both directions. Verified round-trip correctness with all current schema patterns (objects, strings, enums, nullable).

### 6. ManifestSchema for self-validation

**Decision**: The SDK exports a `ManifestSchema` Zod object that the runtime uses to parse and validate `manifest.json` files at load time.

**Rationale**: Catches malformed or corrupted manifests early at startup rather than failing at event dispatch time.

### 7. Explicit workflow file list in Vite config

**Decision**: The plugin takes an explicit list of workflow file paths instead of scanning the `workflows/` directory.

**Rationale**: Explicit configuration prevents accidental inclusion of non-workflow files and makes the build deterministic.

## Risks / Trade-offs

**[Transform fragility]** → The transform hook must correctly identify and rewrite `.action({handler: fn})` patterns. An AST-based approach (not regex) is used to handle multi-line handlers, nested braces, and edge cases reliably.

**[Zod round-trip gaps]** → `z.fromJSONSchema()` doesn't guarantee 1:1 fidelity for all Zod types (e.g., `z.date()`, `z.transform()`). Mitigated: current schemas use only objects, strings, numbers, enums, arrays, and nullable — all verified to round-trip correctly. Future schema additions should be tested for round-trip compatibility.

**[Handler closures over builder state]** → If `.action()` wraps the handler instead of returning `config.handler` directly, the transform approach breaks. Mitigated: SDK contract requires `.action()` to return `config.handler` as-is.

**[Two-pass build performance]** → Each workflow is processed twice. Mitigated: workflow files are small; the manifest pass is a lightweight import + serialize, not a full Vite build.

**[No sandbox API surface change]** → This change does not affect the sandbox boundary. Action handlers continue to receive `ctx` with `data`, `emit`, `env`, and `fetch`. No new APIs are exposed to sandboxed code.
