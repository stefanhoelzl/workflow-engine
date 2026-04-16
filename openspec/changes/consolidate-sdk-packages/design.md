## Context

The monorepo currently has five packages under `packages/`: `sdk`, `vite-plugin`, `cli`, `runtime`, and `sandbox`. Workflow authors must install both `@workflow-engine/sdk` and `@workflow-engine/cli` (which transitively pulls in `@workflow-engine/vite-plugin`). The runtime also depends on `@workflow-engine/sdk` for shared types (`ManifestSchema`, `HttpTriggerResult`, `z`).

The goal is to give workflow authors a single dependency (`@workflow-engine/sdk`) while keeping the runtime's dependency tree lean (no build tooling).

### Current dependency graph

```
@workflow-engine/sdk  (zod only)
  ^
  ├── @workflow-engine/vite-plugin  (sdk + vite + tar-stream + polyfills + ts)
  │     ^
  │     └── @workflow-engine/cli  (vite-plugin + citty + vite)
  │           ^
  │           └── workflows/  (cli + sdk)
  │
  ├── @workflow-engine/runtime  (sdk + sandbox + hono + duckdb + ...)
  └── @workflow-engine/sandbox  (quickjs-emscripten)
```

### Target dependency graph

```
@workflow-engine/core  (zod only, internal)
  ^
  ├── @workflow-engine/sdk  (core + vite + citty + tar-stream + polyfills + ts)
  │     ^
  │     └── workflows/  (sdk only)
  │
  ├── @workflow-engine/runtime  (core + sandbox + hono + duckdb + ...)
  └── @workflow-engine/sandbox  (quickjs-emscripten, no change)
```

## Goals / Non-Goals

**Goals:**
- Single user-facing dependency for workflow authors
- Runtime depends only on the lean `core` package (no build tooling)
- Preserve all existing functionality (DSL, build, upload, `wfe` binary)
- Clean subpath exports: `@workflow-engine/sdk`, `sdk/plugin`, `sdk/cli`

**Non-Goals:**
- npm publishing (deferred; using `workspace:*` for now)
- Changing any runtime behavior, sandbox boundary, or manifest format
- Refactoring the vite-plugin or CLI internals (move as-is)

## Decisions

### D1: What goes into `core`

**Decision:** `core` exports exactly what the runtime needs from the current `sdk`:
- `ManifestSchema` (value) + `Manifest` (type) — manifest validation
- `HttpTriggerResult` (type) — executor/trigger contract
- `z` (re-export from zod) — used in `runtime/config.ts`
- `ajv`-based JSON Schema validator used inside `ManifestSchema` — stays in core since it's part of manifest validation

The `ajv` devDependency moves to `core` as a regular dependency.

**Why not keep brands/DSL in core?** The runtime doesn't import any brands (`ACTION_BRAND`, `HTTP_TRIGGER_BRAND`, `WORKFLOW_BRAND`) or DSL factories. The vite-plugin uses them, but it's moving into `sdk`. Keeping `core` minimal reduces the contract surface between packages.

**Alternative considered:** Duplicate the few types instead of a separate package. Rejected because `ManifestSchema` is a runtime value with `ajv` validation logic — duplicating it risks drift.

### D2: SDK subpath exports

**Decision:** Three entry points via `package.json` `exports` field:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./plugin": "./src/plugin/index.ts",
    "./cli": "./src/cli/index.ts"
  }
}
```

- `.` — DSL (`defineWorkflow`, `action`, `httpTrigger`, `env`) + `z` re-exported from core + brands + type guards
- `./plugin` — `workflowPlugin()` factory + types
- `./cli` — programmatic `build()`, `upload()` + types

**Why subpath exports over flat?** The main entry stays lightweight (no vite/citty/tar-stream in the import graph when you only `import { defineWorkflow } from "@workflow-engine/sdk"`). Tree-shaking could achieve this too, but subpath exports make the boundary explicit and work at the module-resolution level.

### D3: Vite as regular dependency

**Decision:** `vite` moves from a peer dependency (in vite-plugin) to a regular dependency of `sdk`.

**Rationale:** The version range is `>=6.0.0` — wide enough that conflicts are near-impossible. Making it a regular dep simplifies the user's install (one fewer package to manage).

### D4: `wfe` binary in SDK

**Decision:** The `bin` field moves to SDK's `package.json`:

```json
{
  "bin": {
    "wfe": "./dist/cli.js"
  }
}
```

The CLI's existing build step (`tsc -p tsconfig.build.json && node ./scripts/shebang.mjs`) moves to SDK. SDK needs a `build` script that compiles the CLI entry point to `dist/cli.js` with a shebang.

### D5: Source layout within SDK

**Decision:** Organize by concern:

```
packages/sdk/
  src/
    index.ts           (DSL: defineWorkflow, action, httpTrigger, env, z, brands)
    index.test.ts
    plugin/
      index.ts         (moved from vite-plugin/src/index.ts)
      sandbox-globals.js
      sandbox-globals-setup.js
      *.test.ts
    cli/
      index.ts         (re-exports: build, upload, NoWorkflowsFoundError)
      cli.ts           (wfe binary entry point)
      build.ts
      upload.ts
      vite-config.ts
      *.test.ts
  scripts/
    shebang.mjs
```

The plugin and CLI source move largely as-is. Internal import paths change (e.g., `from "@workflow-engine/vite-plugin"` → `from "../plugin/index.js"` or just using the local code directly).

### D6: Core package structure

**Decision:** Minimal package:

```
packages/core/
  package.json         (name: @workflow-engine/core, deps: zod, ajv)
  src/
    index.ts           (ManifestSchema, Manifest, HttpTriggerResult, z, ajv validator)
```

`ManifestSchema` and its supporting `ajv`-based JSON Schema validator are extracted from the current `sdk/src/index.ts`. The `HttpTriggerResult` interface and `HttpTriggerPayload` type also move here (runtime uses `HttpTriggerResult`).

### D7: Internal cross-references after the move

The vite-plugin code currently imports from `@workflow-engine/sdk`:
- `ACTION_BRAND`, `HTTP_TRIGGER_BRAND`, `WORKFLOW_BRAND`, `ManifestSchema`, `isWorkflow`, `Manifest`, `Workflow`

After the move, these become internal imports within `sdk`:
- Brands, `isWorkflow`, `Workflow` → `from "../index.js"` (or a shared internal module)
- `ManifestSchema`, `Manifest` → `from "@workflow-engine/core"` (sdk depends on core)

The CLI code currently imports from `@workflow-engine/vite-plugin`:
- `workflowPlugin` → `from "../plugin/index.js"`

## Risks / Trade-offs

**[Risk] Large diff touching many files** → Mitigation: The change is purely structural (no behavior changes). All tests must pass after the move. Run `pnpm validate` as the gate.

**[Risk] Import path breakage in runtime tests** → Runtime's dev dependency on `@workflow-engine/vite-plugin` (used in `cross-package.test.ts`) must change to `@workflow-engine/sdk`. Mitigation: update the dev dependency and import path.

**[Risk] CLI build step in SDK** → SDK currently has no build step. Adding `tsc` compilation for the CLI binary entry point is new complexity. Mitigation: Keep it isolated — only the `cli.ts` entry point needs compilation; the rest of SDK stays source-only (resolved via TypeScript project references / workspace protocol).

**[Trade-off] `core` is very small (4 exports)** → Accepted: it's the single source of truth for the runtime/SDK contract. The alternative (duplication) risks drift of `ManifestSchema` validation logic.
