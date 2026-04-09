## 1. SDK: New builder API

- [x] 1.1 Replace `workflow()` with `createWorkflow()` and collapse 4 phased interfaces into single `WorkflowBuilder<E>` generic interface
- [x] 1.2 Change `.action()` to accept config without name (optional `name` field), return `config.handler` directly with full ctx type inference
- [x] 1.3 Implement `.compile()` method: extract events (with `z.toJSONSchema()`), triggers, and actions (with handler references) into serializable output
- [x] 1.4 Add `ManifestSchema` Zod object and `Manifest` type, export from SDK
- [x] 1.5 Remove `.build()`, `WorkflowConfig`, `ActionConfig` types and exports
- [x] 1.6 Update SDK tests: rewrite all `workflow()` → `createWorkflow()`, `.build()` → `.compile()`, add tests for `.action()` return type and handler reference equality

## 2. Vite Plugin package

- [x] 2.1 Create `packages/vite-plugin` package with `package.json`, TypeScript config, and workspace registration in `pnpm-workspace.yaml`
- [x] 2.2 Implement manifest extraction pass: import workflow module, call `.compile()`, match handler refs to named exports via reference equality, resolve action names
- [x] 2.3 Implement Vite transform hook: AST-based extraction of handler functions from `.action()` wrappers, preserving module-level imports and constants
- [x] 2.4 Implement per-workflow output: write `manifest.json` and bundle `actions.js` into `dist/<name>/` subdirectories
- [x] 2.5 Add build error handling: fail on `.compile()` errors, unmatched handler exports, and manifest validation failures
- [x] 2.6 Add tests for plugin: manifest generation, transform correctness, tree-shaking verification (no Zod/SDK in actions.js output), error cases

## 3. Runtime: Manifest-based loader

- [x] 3.1 Rewrite `loader.ts`: scan for subdirectories with `manifest.json`, parse via `ManifestSchema`, reconstruct event schemas with `z.fromJSONSchema()`, import actions module and match exports
- [x] 3.2 Update `main.ts`: replace `loadWorkflow(wf: WorkflowConfig)` and `registerWorkflows()` to work with manifest-loaded data, build `allEvents` from manifest schemas
- [x] 3.3 Simplify `Action` type in `actions/index.ts`: remove `on.schema`, keep `{ name, on, handler }`
- [x] 3.4 Update loader tests: test manifest.json parsing, schema reconstruction, actions.js import, error handling (malformed manifest, missing exports)
- [x] 3.5 Update integration test and scheduler test for simplified Action type

## 4. Workflow migration

- [x] 4.1 Rewrite `workflows/cronitor.ts` to new authoring format: `createWorkflow()`, handler exports via `.action()`, default export builder
- [x] 4.2 Update `workflows/vite.config.ts` to use `@workflow-engine/vite-plugin` with explicit workflow list
- [x] 4.3 Add `@workflow-engine/vite-plugin` as workspace dependency in `workflows/package.json`

## 5. Build integration

- [x] 5.1 Update root `vite.config.ts` devServer plugin to watch for `dist/*/manifest.json` instead of `dist/*.js`
- [x] 5.2 Verify full build: `pnpm build` produces `dist/main.js` and `workflows/dist/cronitor/manifest.json + actions.js`
- [x] 5.3 Verify `pnpm lint`, `pnpm check`, and `pnpm test` all pass
