## Why

The runtime currently hardcodes a single workflow (`sample.ts`) as a static import. To support multiple independently-developed workflows and move toward the final architecture, the runtime needs to dynamically discover and load workflow bundles from a directory at startup.

## What Changes

- Move the Cronitor workflow out of `packages/runtime/src/sample.ts` into a standalone `workflows/cronitor.ts` file with its own Vite build
- Add a workflow loader to the runtime that scans a `WORKFLOW_DIR` for `.js` files and loads each via dynamic `import()`
- Add `WORKFLOW_DIR` as a required environment variable to the runtime config schema
- Merge triggers and actions from all loaded workflows into a shared registry, failing on duplicate trigger paths
- Update `pnpm start` to build workflows before starting the runtime

## Capabilities

### New Capabilities
- `workflow-loading`: Dynamic discovery and loading of workflow bundles from a directory at runtime startup
- `workflow-build`: Vite-based build pipeline for compiling workflow `.ts` files into self-contained ESM bundles

### Modified Capabilities
- `runtime-config`: Add required `WORKFLOW_DIR` environment variable to the config schema
- `vite-build`: Root `pnpm build` now also builds workflows; root Vite config is for runtime only, workflows have their own
- `monorepo-structure`: Add `workflows` directory to pnpm workspace for dependency resolution (not a scoped package)

## Impact

- **`packages/runtime/src/main.ts`**: Remove static `sample.ts` import, add dynamic loader call
- **`packages/runtime/src/sample.ts`**: Deleted — content moves to `workflows/cronitor.ts`
- **`packages/runtime/src/config.ts`**: Add `WORKFLOW_DIR` to Zod schema
- **`workflows/`**: New directory with `cronitor.ts`, `vite.config.ts`, `package.json`
- **`pnpm-workspace.yaml`**: Add `workflows` entry
- **Root `package.json`**: Update `build` and `start` scripts to include workflow build step
