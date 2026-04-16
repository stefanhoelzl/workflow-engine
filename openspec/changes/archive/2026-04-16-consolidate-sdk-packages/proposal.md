## Why

Workflow authors currently need to install two packages (`@workflow-engine/sdk` and `@workflow-engine/cli`) and implicitly pull in a third (`@workflow-engine/vite-plugin`). The SDK should be the single user-facing dependency that provides the authoring DSL, the Vite build plugin, and the CLI. However, the runtime also depends on `@workflow-engine/sdk` for shared types (`ManifestSchema`, `HttpTriggerResult`, `z`), so the SDK cannot simply absorb heavy build dependencies without bloating the runtime. A new internal `core` package extracts the lean shared contract, freeing the SDK to absorb the build tooling.

## What Changes

- **New `@workflow-engine/core` package** containing only the shared contract types and schemas (`ManifestSchema`, `Manifest`, `HttpTriggerResult`, `z` re-export). Depends only on `zod`.
- **SDK absorbs vite-plugin code** into `src/plugin/`. Exposed via subpath export `@workflow-engine/sdk/plugin`.
- **SDK absorbs CLI code** into `src/cli/`. Exposed via subpath export `@workflow-engine/sdk/cli`. The `wfe` binary moves to SDK's `bin` field.
- **SDK re-exports `z` from core** so workflow authors keep using `import { z, defineWorkflow } from "@workflow-engine/sdk"`.
- **SDK takes on vite as a regular dependency** (not peer), plus all current vite-plugin and CLI dependencies (`citty`, `tar-stream`, `typescript`, polyfills, etc.).
- **Runtime switches from `@workflow-engine/sdk` to `@workflow-engine/core`** for its imports.
- **`@workflow-engine/vite-plugin` and `@workflow-engine/cli` packages are deleted.**
- **`workflows/package.json` simplified** to depend only on `@workflow-engine/sdk`.
- **`monorepo-structure` spec updated** to reflect the new package set (`core`, `sdk`, `sandbox`, `runtime`).

## Capabilities

### New Capabilities
- `core-package`: Internal package providing the lean shared contract (types, schemas, zod re-export) between SDK and runtime.

### Modified Capabilities
- `sdk`: Absorbs authoring DSL + vite plugin + CLI into a single package with subpath exports.
- `vite-plugin`: Moves into SDK. Spec requirements unchanged but the module location and import path change.
- `cli`: Moves into SDK. Spec requirements unchanged but the binary source and import path change.
- `monorepo-structure`: Package list changes (remove vite-plugin and cli, add core).
- `workflow-build`: `workflows/package.json` dependencies and vite config import path change.
- `build-system`: SDK now has its own build step (compiling CLI binary entry point for `bin`).

## Impact

- **Packages added:** `packages/core/`
- **Packages removed:** `packages/vite-plugin/`, `packages/cli/`
- **Import paths:** `@workflow-engine/vite-plugin` becomes `@workflow-engine/sdk/plugin`; `@workflow-engine/cli` becomes `@workflow-engine/sdk/cli`
- **Runtime dependencies:** runtime switches `@workflow-engine/sdk` -> `@workflow-engine/core`
- **User-facing:** workflow authors install only `@workflow-engine/sdk` instead of `sdk` + `cli`
- **Binary:** `wfe` CLI binary now provided by `@workflow-engine/sdk`
- **No behavioral changes:** all existing functionality is preserved, only package boundaries move
