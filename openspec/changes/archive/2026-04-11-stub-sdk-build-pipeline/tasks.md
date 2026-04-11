## 1. Manifest Schema + Action Interface

- [x] 1.1 Add top-level `module: z.string()` field to `ManifestSchema` in `packages/sdk/src/index.ts`
- [x] 1.2 Replace per-action `module: z.string()` with `export: z.string()` in `ManifestSchema` action schema
- [x] 1.3 Update `Manifest` type (auto-derived from schema) and update `ManifestAction` interface in `packages/vite-plugin/src/index.ts`
- [x] 1.4 Add `exportName: string` to `Action` interface in `packages/runtime/src/actions/index.ts`

## 2. Vite Plugin — Stub SDK Build

- [x] 2.1 Add `SDK_STUB` constant to `packages/vite-plugin/src/index.ts` — stub `createWorkflow`, `z` (recursive Proxy), `http`, `env`, `ENV_REF`, `ManifestSchema`
- [x] 2.2 Add `buildWorkflowModule(workflowPath, root)` function — single `vite.build()` with stub SDK plugin (`enforce: 'pre'`, `build.ssr: true`, `ssr.noExternal: true`, `rollupOptions.input`, `write: false`)
- [x] 2.3 Rewrite `processEntryChunk` — use `tsImport()` for metadata extraction instead of temp file + dynamic import
- [x] 2.4 Simplify `extractManifest` — remove `code` param, return `exportMap` instead of `actionSources`, emit top-level `module` and per-action `export` in manifest
- [x] 2.5 Update `processEntryChunk` output — emit single `actions.js` instead of per-action files under `actions/`
- [x] 2.6 Delete `extractHandlerSource`, `findMatchingBrace`, `ACTION_CALL_RE`, `HANDLER_KEY_RE`
- [x] 2.7 Remove unused imports (`writeFile`, `tmpdir`) and add new imports (`tsImport`, `build`, `pathToFileURL`)

## 3. Workflow Registry + Scheduler

- [x] 3.1 Update `buildLoadedWorkflow` in `packages/runtime/src/workflow-registry.ts` — read source from `manifest.module`, add `exportName: actionDef.export` to each action
- [x] 3.2 Update `executeAction` in `packages/runtime/src/services/scheduler.ts` — pass `exportName: action.exportName` in `SpawnOptions`

## 4. Sandbox — ES Module Evaluation

- [x] 4.1 Add `exportName?: string` to `SpawnOptions` interface in `packages/runtime/src/sandbox/index.ts`
- [x] 4.2 Replace regex stripping + function expression eval with `vm.evalCode(source, filename, { type: "module" })` and `vm.getProp(moduleNamespace, exportName)`
- [x] 4.3 Delete `EXPORT_DEFAULT_RE` and `TRAILING_SEMICOLON_RE` constants
- [x] 4.4 Verify sandbox isolation tests still pass (action cannot access `process`, `require`, `fetch`, `globalThis.constructor`) — these use `export default` which works via default `exportName`

## 5. Test Updates

- [x] 5.1 Add `exportName: "default"` to mock `Action` objects in `packages/runtime/src/integration.test.ts`
- [x] 5.2 Add `exportName: "default"` to mock `Action` objects in `packages/runtime/src/services/scheduler.test.ts`
- [x] 5.3 Add `exportName: "default"` to mock `Action` objects in `packages/runtime/src/event-bus/recovery.test.ts`
- [x] 5.4 Update manifest fixtures in `packages/runtime/src/api/upload.test.ts` — add top-level `module`, replace per-action `module` with `export`

## 6. Verification

- [x] 6.1 Run `pnpm build` — verify `dist/cronitor/actions.js` is ~2.3KB with named exports, no Zod/SDK code
- [x] 6.2 Run `pnpm validate` — lint, format, typecheck, and all tests pass
- [x] 6.3 Inspect `dist/cronitor/manifest.json` — verify top-level `module` field and per-action `export` fields
