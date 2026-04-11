## Context

The current Vite plugin uses regex and brace-matching to extract handler function bodies from Vite's bundled output. This produces minimal per-action files but breaks when handlers import npm libraries, because module-scope code (imports, constants) is lost during extraction. The sandbox evaluates these bare function bodies by stripping `export default` and wrapping as `(async (ctx) => {...})`.

Phase 1 (bridge factory + auto-logging) is complete on `sandbox-build-pipeline`. This is Phase 2: replacing the extraction mechanism and module evaluation strategy.

## Goals / Non-Goals

**Goals:**
- Action handlers can import npm libraries and have them bundled correctly
- Eliminate SDK/Zod (~128KB) from action module output
- Sandbox evaluates proper ES modules instead of bare function expressions
- Simplify the manifest format to reflect single-bundle-per-workflow reality
- Remove fragile regex extraction code

**Non-Goals:**
- Polyfill support in sandbox (Phase 3)
- Per-action tree-shaking isolation (explored, ineffective due to shared workflow object)
- Removing the step-1 Vite build entirely (kept for now, can optimize later)
- Watch mode changes

## Decisions

### 1. Single stub-SDK Vite build per workflow (not per-action builds)

Each workflow gets one `vite.build()` call that produces a single `actions.js` with all handlers as named exports. A stub plugin replaces `@workflow-engine/sdk` with a ~15-line stub where `workflow.action({ handler })` returns `handler` directly.

**Why not per-action builds?** Tree-shaking cannot separate actions because they share the `workflow` object. Per-action builds produce N near-identical ~2.3KB modules. A single build produces the same output once.

**Why not regex from bundled code (current)?** Loses module-scope imports. The whole motivation for this change.

**Why not emit the full 128KB bundle without stub?** Wastes sandbox parse time on Zod/SDK code that actions never use.

**Verified constraints:**
- `build.ssr: true` required for virtual modules to survive Vite 8's output pipeline
- `enforce: 'pre'` on the stub plugin required to intercept `@workflow-engine/sdk` before Vite's own resolution
- `rollupOptions.input` (not `lib.entry`) required for plugin-resolved entries
- Workflow `.ts` file works directly as build input — no virtual entry module needed

### 2. Metadata extraction via tsx instead of bundle import

Use `tsImport()` from `tsx/esm/api` to import the original `.ts` workflow source for `compile()` metadata. This avoids writing a temp file and importing it.

**Why tsx?** Already a root devDependency. Handles TypeScript natively. The SDK resolves from the workspace. `compile()` returns plain data — no bundling needed.

### 3. `module` field at manifest top level (not per-action)

With a single bundle, all actions reference the same file. Repeating `module: "actions.js"` on each action is redundant. Moving it to the manifest root is cleaner and reflects the actual data model.

**Alternative:** Keep `module` per-action for backwards compatibility. Rejected because this is already a breaking change (adding `export` field), so the migration cost is the same.

### 4. `source` stays on the Action interface

Despite all actions in a workflow sharing the same source string, moving `source` to a workflow-level structure would require restructuring the scheduler's `actionSource` interface and how actions are dispatched. Since JS string references are shared (no memory duplication), keeping `source` on `Action` avoids a scheduler refactor without real cost.

### 5. ES module evaluation in sandbox with named export extraction

Use `vm.evalCode(source, filename, { type: "module" })` to evaluate action source as an ES module. Extract the handler via `vm.getProp(moduleNamespace, exportName)`.

**Why named exports instead of default?** With a shared module, each action needs a different export. The sandbox receives `exportName` via `SpawnOptions` (defaults to `"default"` for backward compatibility with tests).

## Risks / Trade-offs

- **Manifest format is a breaking change** → All existing bundles are incompatible. Acceptable because: no production deployments yet, and the runtime validates manifests at load time (clear error on mismatch).
- **Stub SDK must match real SDK's builder surface** → If the SDK adds new builder methods (e.g., `.middleware()`), the stub needs updating. Mitigated by: the stub is ~15 lines, the builder API is stable, and build failures are immediate and obvious.
- **Step-1 Vite build still runs (~850ms, 128KB output thrown away)** → Acceptable short-term cost. Can be eliminated later by using tsx for metadata + removing workflow entries from the Vite config.
- **No per-action isolation** → All actions in a workflow parse the same ~2.3KB module. The "other" action's handler code is present but never called. Acceptable because: sandbox creates a fresh context per action, and the dead code is tiny.

```
BUILD FLOW
══════════════════════════════════════════════════════════

  Step 1 (kept, output discarded)    Step 2 (new)
  ┌──────────────────────┐           ┌──────────────────────────┐
  │ Vite builds workflow │           │ tsx import cronitor.ts   │
  │ entries (existing     │           │   → compile() → metadata │
  │ config, ~850ms)      │           │                          │
  │                      │           │ vite.build(cronitor.ts,  │
  │ Chunks deleted in    │           │   { sdk: stub })         │
  │ generateBundle       │           │   → 2.3KB actions.js     │
  └──────────────────────┘           └──────────────────────────┘
```

## Open Questions

_(none — all design questions resolved through prototyping in conversation)_
