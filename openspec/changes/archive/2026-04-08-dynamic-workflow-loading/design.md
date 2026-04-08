## Context

The runtime currently imports a single workflow (`sampleWorkflow`) as a static TypeScript import in `main.ts`. This couples the runtime to a specific workflow at compile time. The goal is to decouple workflows from the runtime so they are independently buildable and dynamically loaded at startup.

Current flow:
```
main.ts ──static import──▶ sample.ts ──import──▶ @workflow-engine/sdk
```

Target flow:
```
main.ts ──readdir(WORKFLOW_DIR)──▶ *.js ──dynamic import()──▶ WorkflowConfig
```

## Goals / Non-Goals

**Goals:**
- Workflows live outside `packages/runtime/` as independent source files
- Each workflow is compiled to a self-contained ESM bundle via Vite
- The runtime discovers and loads all `.js` files from a configurable directory
- `pnpm build` and `pnpm start` work end-to-end without manual steps

**Non-Goals:**
- Hot-reloading or watch mode for workflow changes
- Validation of the default export shape at load time (trust the export)
- Workflow isolation / sandboxing (future concern)
- Supporting multiple workflows per file

## Decisions

### 1. Workflow directory structure: flat files, not packages

Workflows live as flat `.ts` files in `workflows/` (e.g., `workflows/cronitor.ts`), not as nested packages with their own `src/` directories.

`workflows/` has a `package.json` for dependency resolution only (declares `@workflow-engine/sdk` as a workspace dependency) and is listed in `pnpm-workspace.yaml`. It is not a scoped `@workflow-engine/` package.

**Alternatives considered:**
- Each workflow as a separate workspace package (`packages/cronitor/`) — too much scaffolding for a single file
- No package.json, rely on hoisted deps — fragile, pnpm strict mode would break it

### 2. Shared Vite config in `workflows/vite.config.ts`

A single `workflows/vite.config.ts` builds all `.ts` files in the directory into `workflows/dist/*.js`. Each workflow becomes one self-contained ESM bundle with the SDK bundled in (no external runtime dependency on `@workflow-engine/sdk`).

**Alternatives considered:**
- Per-workflow vite.config.ts — unnecessary given the uniform build requirements
- tsc compilation — doesn't bundle, would leave SDK as external import

### 3. `WORKFLOW_DIR` as required config

Added to the existing Zod config schema in `config.ts`. The runtime fails at startup if `WORKFLOW_DIR` is not set. This is consistent with how `PORT` and `LOG_LEVEL` are handled.

**Alternatives considered:**
- CLI argument — inconsistent with existing env-based config
- Default to `./workflows` — too implicit, better to be explicit

### 4. Loader scans for `.js` files and uses `import()` with default export

The loader reads the directory, filters for `.js` files, and calls `import()` on each. It expects a default export of type `WorkflowConfig`. Files that fail to load are logged as warnings and skipped. An empty directory is valid (runtime starts with no workflows).

**Alternatives considered:**
- Named export — requires the runtime to know the export name
- Package-based loading (read package.json per dir) — overengineered for flat files

### 5. Merge all workflows into shared registries

All loaded workflows merge into a single `HttpTriggerRegistry` and a single actions list. The existing `loadWorkflow()` function is called per workflow, and results are combined. Duplicate trigger paths (same path + method) across workflows cause a startup failure.

**Alternatives considered:**
- Isolated registries per workflow — requires routing plumbing changes, unnecessary complexity now

### 6. Build-then-start in `pnpm start`

Root `pnpm start` chains: build workflows, then start runtime with `WORKFLOW_DIR` set.

```
"start": "pnpm --filter workflows build && WORKFLOW_DIR=$PWD/workflows/dist pnpm --filter @workflow-engine/runtime start"
```

`$PWD` resolves to the repo root, which is necessary because `pnpm --filter @workflow-engine/runtime start` sets cwd to `packages/runtime/`.

## Risks / Trade-offs

- **[Startup time]** Dynamic `import()` of many workflow files could slow startup → Acceptable for the expected number of workflows. Monitor if it grows.
- **[No shape validation]** A malformed `.js` file with a wrong default export will cause a runtime error during workflow loading, not at startup validation time → Mitigated by the build pipeline producing correct outputs. Can add validation later.
- **[Path resolution]** `WORKFLOW_DIR` must be an absolute path or correctly resolved relative path → Using `$PWD` in the start script handles the dev case. Production (Docker) will use an absolute path.
- **[SDK version skew]** Bundling SDK into each workflow means different workflows could embed different SDK versions → Acceptable in a monorepo where all workflows build from the same lockfile.
