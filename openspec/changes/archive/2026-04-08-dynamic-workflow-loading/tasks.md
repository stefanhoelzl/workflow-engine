## 1. Workspace & Build Setup

- [x] 1.1 Create `workflows/package.json` with unscoped name and `@workflow-engine/sdk` workspace dependency
- [x] 1.2 Add `workflows` to `pnpm-workspace.yaml`
- [x] 1.3 Create `workflows/vite.config.ts` that builds all `.ts` files into `workflows/dist/` as self-contained ESM bundles
- [x] 1.4 Add `workflows/tsconfig.json` extending the base config

## 2. Move Workflow

- [x] 2.1 Move `packages/runtime/src/sample.ts` to `workflows/cronitor.ts`, change to default export
- [x] 2.2 Remove the static `sampleWorkflow` import from `packages/runtime/src/main.ts`

## 3. Runtime Config

- [x] 3.1 Add required `WORKFLOW_DIR` field to the Zod schema in `config.ts`
- [x] 3.2 Update config tests for `WORKFLOW_DIR` (required, no default)

## 4. Dynamic Loader

- [x] 4.1 Create `packages/runtime/src/loader.ts` — scan `WORKFLOW_DIR` for `.js` files, `import()` each, return array of `WorkflowConfig` from default exports, log warnings on failures
- [x] 4.2 Add unit tests for the loader (empty dir, valid files, failing files, no default export)

## 5. Runtime Integration

- [x] 5.1 Update `main.ts` to call the loader, merge registries and actions from all loaded workflows, detect duplicate trigger paths
- [x] 5.2 Update integration test to pass `WORKFLOW_DIR` env var in config setup

## 6. Root Scripts

- [x] 6.1 Update root `package.json` `build` script to also build workflows
- [x] 6.2 Update root `package.json` `start` script to build workflows then start runtime with `WORKFLOW_DIR=$PWD/workflows/dist`

## 7. Verify

- [x] 7.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` — all pass
- [x] 7.2 Run `pnpm start` end-to-end — runtime starts and loads cronitor workflow
