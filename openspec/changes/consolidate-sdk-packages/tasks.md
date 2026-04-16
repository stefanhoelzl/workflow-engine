## 1. Create core package

- [x] 1.1 Create `packages/core/` directory with `package.json` (name: `@workflow-engine/core`, private: true, type: module, deps: zod + ajv, exports: `{ ".": "./src/index.ts" }`)
- [x] 1.2 Create `packages/core/src/index.ts` — extract `ManifestSchema`, `Manifest`, `HttpTriggerResult`, `HttpTriggerPayload`, `z` re-export, and the ajv-based JSON Schema validator from `packages/sdk/src/index.ts`
- [x] 1.3 Add `packages/core/tsconfig.json` extending `../../tsconfig.base.json`

## 2. Refactor SDK to depend on core

- [x] 2.1 Add `@workflow-engine/core: workspace:*` to SDK's dependencies, remove `ajv` devDependency
- [x] 2.2 Update `packages/sdk/src/index.ts` — import `ManifestSchema`, `Manifest`, `HttpTriggerResult`, `HttpTriggerPayload`, `z` from `@workflow-engine/core` and re-export them. Remove the extracted code (manifest schema, ajv validator, HttpTriggerResult interface, z import from zod). Keep brands, DSL factories, type guards, and all other SDK code.
- [x] 2.3 Verify `pnpm check` and `pnpm test` pass with the sdk/core split

## 3. Move vite-plugin into SDK

- [x] 3.1 Move `packages/vite-plugin/src/index.ts` to `packages/sdk/src/plugin/index.ts` and `packages/vite-plugin/src/sandbox-globals.js`, `sandbox-globals-setup.js` to `packages/sdk/src/plugin/`
- [x] 3.2 Move vite-plugin test files to `packages/sdk/src/plugin/`
- [x] 3.3 Update imports in the moved plugin code: replace `from "@workflow-engine/sdk"` with relative imports to `../index.js` for brands/type guards and `from "@workflow-engine/core"` for `ManifestSchema`/`Manifest`
- [x] 3.4 Add vite-plugin's dependencies to SDK's `package.json` — tar-stream, tsx, typescript, all polyfill packages, @types/tar-stream (dev). Move vite from peer dep to regular dep.
- [x] 3.5 Add `"./plugin": "./src/plugin/index.ts"` to SDK's exports field
- [x] 3.6 Delete `packages/vite-plugin/` directory

## 4. Move CLI into SDK

- [x] 4.1 Move `packages/cli/src/cli.ts`, `build.ts`, `upload.ts`, `vite-config.ts`, `index.ts` to `packages/sdk/src/cli/`
- [x] 4.2 Move CLI test files to `packages/sdk/src/cli/`
- [x] 4.3 Move `packages/cli/scripts/shebang.mjs` to `packages/sdk/scripts/shebang.mjs`
- [x] 4.4 Update imports in CLI code: replace `from "@workflow-engine/vite-plugin"` with relative import to `../plugin/index.js` in `vite-config.ts`
- [x] 4.5 Add CLI dependencies to SDK's `package.json` — `citty`
- [x] 4.6 Add `"./cli": "./src/cli/index.ts"` to SDK's exports field
- [x] 4.7 Add `"bin": { "wfe": "./dist/cli.js" }` to SDK's `package.json`
- [x] 4.8 Add CLI build step: create `tsconfig.build.json` for SDK and add `build` script (`tsc -p tsconfig.build.json && node ./scripts/shebang.mjs`)
- [x] 4.9 Delete `packages/cli/` directory

## 5. Update consumers

- [x] 5.1 Update `packages/runtime/package.json` — replace `@workflow-engine/sdk: workspace:*` with `@workflow-engine/core: workspace:*`, replace `@workflow-engine/vite-plugin: workspace:*` (devDep) with `@workflow-engine/sdk: workspace:*`
- [x] 5.2 Update all runtime source imports — change `from "@workflow-engine/sdk"` to `from "@workflow-engine/core"` for `ManifestSchema`, `Manifest`, `HttpTriggerResult`, `z`
- [x] 5.3 Update runtime test imports (`cross-package.test.ts`) — keep `@workflow-engine/sdk` for DSL imports (defineWorkflow, action, etc.), use `@workflow-engine/core` for schema/type imports
- [x] 5.4 Update `workflows/package.json` — remove `@workflow-engine/cli` dependency, keep only `@workflow-engine/sdk`

## 6. Update workspace configuration

- [x] 6.1 Run `pnpm install` to regenerate lockfile with new package layout
- [x] 6.2 Update root build script if it references cli or vite-plugin packages

## 7. Validate

- [x] 7.1 Run `pnpm validate` (lint + format check + type check + tests) — all must pass
- [x] 7.2 Verify `pnpm exec wfe upload --help` works from the workflows directory
