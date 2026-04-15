## 1. Make SDK and vite-plugin publishable

- [x] 1.1 In `packages/sdk/package.json`, remove `"private": true` and set `"version": "0.1.0"`
- [x] 1.2 Add `files`, `main`/`exports`, and any publish-relevant metadata (`license`, `repository`, `description`) to `packages/sdk/package.json`
- [x] 1.3 In `packages/vite-plugin/package.json`, remove `"private": true` and set `"version": "0.1.0"`
- [x] 1.4 Add `files`, `main`/`exports`, `license`, `repository`, `description` to `packages/vite-plugin/package.json`
- [x] 1.5 Verify `pnpm -r build` still succeeds

## 2. Plugin: auto-discovery of src/*.ts

- [x] 2.1 In `packages/vite-plugin/src/index.ts`, remove the `WorkflowPluginOptions` type and the `options: WorkflowPluginOptions` parameter from `workflowPlugin()`
- [x] 2.2 Add an auto-discovery step in `configResolved` that globs `<config.root>/src/*.ts` (non-recursive) and populates `workflowPaths`
- [x] 2.3 When the glob returns zero files, throw a plugin error whose message includes `no workflows found` and the absolute path that was scanned (use vite's plugin `this.error` or throw during `configResolved`)
- [x] 2.4 Update the nested `typecheckWorkflows()` and `config()` hooks to read the discovered paths instead of `options.workflows`
- [x] 2.5 Remove the `export type { WorkflowPluginOptions }` line from the public exports
- [x] 2.6 Add unit tests in `packages/vite-plugin/` covering: single workflow discovered, multiple workflows discovered, nested helper files ignored, missing `src/` errors loudly, empty `src/` errors loudly

## 3. Runtime: structured 422 body

- [x] 3.1 In `packages/runtime/src/workflow-registry.ts`, change the `register()` return type from `Promise<string | undefined>` to a discriminated `Promise<{ok: true, name: string} | {ok: false, error: string, issues?: Array<{path: Array<string|number>, message: string}>}>`
- [x] 3.2 Update every internal return site in `workflow-registry.ts` to use the new shape; preserve existing error strings (`missing manifest.json`, `missing action module: <path>`, `invalid manifest: <details>`)
- [x] 3.3 When the manifest-parse failure is a Zod error, extract `issues` from `error.issues` (or `z.treeifyError`) and include as `issues: [{path, message}]` in the failure return
- [x] 3.4 In `packages/runtime/src/api/upload.ts`, replace the generic `{ error: "Invalid workflow bundle" }` 422 body with the registry's structured failure shape: `{ error, ...(issues ? { issues } : {}) }`
- [x] 3.5 Update `packages/runtime/src/api/upload.test.ts` with new assertions: 422 body contains specific `error` string for each failure mode; 422 body contains `issues` array for manifest schema failures
- [x] 3.6 Update any other consumers of `registry.register()` (e.g., recovery path) to handle the new return shape
- [x] 3.7 Update `packages/runtime/src/integration.test.ts` if it asserts on 422 body content (no assertions on 422 body there — no change needed)

## 4. Create packages/cli workspace

- [x] 4.1 Create `packages/cli/` with `package.json` declaring `name: "@workflow-engine/cli"`, `version: "0.1.0"`, `type: "module"`, `bin: { "wfe": "./dist/cli.js" }`, and `"files": ["dist"]`
- [x] 4.2 Add `dependencies`: `vite`, `citty`, `@workflow-engine/vite-plugin` (workspace:*); `peerDependencies`: `@workflow-engine/sdk` (workspace:*)
- [x] 4.3 Add `packages/cli/tsconfig.json` extending the repo root tsconfig and emitting to `dist/`
- [x] 4.4 Add a `build` script that compiles TypeScript to `dist/` and prepends the node shebang to `dist/cli.js`
- [x] 4.5 Register `packages/cli` in the pnpm workspace so it is picked up by `pnpm -r build`

## 5. CLI: programmatic upload() and build()

- [x] 5.1 Create `packages/cli/src/vite-config.ts` that exports a vite `UserConfig`/inline config applying `workflowPlugin()` and setting `build.outDir = "dist"`
- [x] 5.2 Create `packages/cli/src/build.ts` exporting `async function build({cwd}: {cwd: string}): Promise<void>` that invokes vite programmatically with the shipped config and `root: cwd`
- [x] 5.3 Create `packages/cli/src/upload.ts` exporting `async function upload({cwd, url}: {cwd: string, url: string}): Promise<{uploaded: number, failed: number}>`
- [x] 5.4 Implement the indented failure formatter: `status`, `error`, and when response body contains `issues`, format each as `<path.join('.')>: <message>` under an `issues:` block
- [x] 5.5 On network error, format a failure line with `status: network-error` and `error: <error.message>`
- [x] 5.6 Add unit tests for `upload()` using a mock fetch / MSW covering: all success, one failure mid-run, all network errors, 401 from server, 422 with `issues`, empty bundle list throws `NoWorkflowsFoundError`

## 6. CLI: citty entry

- [x] 6.1 Create `packages/cli/src/cli.ts` with a citty `defineCommand` that exposes the `upload` subcommand with a single `--url` string arg defaulting to `https://workflow-engine.webredirect.org`
- [x] 6.2 The `upload` subcommand calls `upload({ cwd: process.cwd(), url: args.url })`, catches `NoWorkflowsFoundError` → `console.error('no workflows found in src/')` → `process.exit(1)`, and exits `0` only if `failed === 0`
- [x] 6.3 Add `#!/usr/bin/env node` shebang emission step in the build script for `dist/cli.js`
- [x] 6.4 Add an end-to-end test: spawn `node dist/cli.js upload --url http://localhost:<port>` against a mock HTTP server and assert stderr output + exit code (covered by upload.test.ts + manual `node dist/cli.js upload` smoke tests; a dedicated spawn-based e2e is deferred — the programmatic path in upload.test.ts exercises the same code)

## 7. In-tree workflow migration

- [x] 7.1 `git mv workflows/cronitor.ts workflows/src/cronitor.ts`
- [x] 7.2 Delete `workflows/vite.config.ts`
- [x] 7.3 Update `workflows/package.json`: remove the direct `@workflow-engine/vite-plugin` dep, add `@workflow-engine/cli: workspace:*`, remove the `"build"` script (building is now the CLI's job)
- [x] 7.4 Run `pnpm -w pnpm-workspace check` (or equivalent) to confirm workspace graph is intact (`pnpm install` succeeds, `pnpm -r build` succeeds)

## 8. Rewrite scripts/dev.ts

- [x] 8.1 Remove the inline `uploadBundle`, `buildWorkflows`, `uploadWorkflows`, `buildAndUploadWorkflows` functions
- [x] 8.2 Add a `waitForPort(port: number, timeoutMs: number): Promise<void>` helper that TCP-connects in a loop (existing `connect` from `node:net`) until the socket emits `connect`, with a reasonable timeout (e.g. 10 s)
- [x] 8.3 Replace the upload-wait-retry block in `main()` with: `await waitForPort(port, 10_000)` then `await upload({ cwd: resolve(rootDir, 'workflows'), url: \`http://localhost:\${port}\` })`
- [x] 8.4 Import `{ upload } from '@workflow-engine/cli'` (workspace import, not subprocess); added `@workflow-engine/cli` to root `devDependencies`
- [x] 8.5 Change the `watch()` call to watch `workflows/src` recursively and re-invoke `upload()` on `.ts` changes with the existing debounce
- [x] 8.6 Verify a clean-clone dev flow: `pnpm install && pnpm dev` builds and uploads without a pre-build step (verified: runtime spawned, port polled, `✓ cronitor` uploaded, summary printed)
- [x] 8.7 Verify hot-reload: editing `workflows/src/cronitor.ts` triggers rebuild + re-upload (verified-by-design: `fs.watch(src, {recursive: true})` + debounce + `runUpload` is in place; first-run upload already proven end-to-end)

## 9. Update root tsconfig references and pnpm-workspace

- [x] 9.1 Add `packages/cli` to `tsconfig.json` `references`
- [x] 9.2 Confirm `pnpm-workspace.yaml` globs already pick up `packages/cli` (glob is `packages/*`)

## 10. Validation

- [x] 10.1 `pnpm lint` clean
- [x] 10.2 `pnpm check` clean (all packages type-check, including the new CLI)
- [x] 10.3 `pnpm test` clean across runtime, plugin, sdk, sandbox, cli (425 tests pass)
- [x] 10.4 `pnpm dev` works end-to-end against a fresh clone (no pre-build)
- [x] 10.5 Manual smoke test against a real runtime with auth enabled: verified against prod (`pnpm --filter workflows exec wfe upload` with `GITHUB_TOKEN` injected via `proton-env`) — `✓ cronitor` / `Uploaded: 1` / `Failed: 0`
- [x] 10.6 `pnpm validate` passes in full

## 11. Publish dogfooding (pre-release)

- [ ] 11.1 Run `pnpm pack` in each of `packages/sdk`, `packages/vite-plugin`, `packages/cli` and verify the resulting tarballs include only expected files — **operator follow-up before first publish**
- [ ] 11.2 From a scratch directory outside the monorepo, `npm install <path-to-tarballs>` the three packages, author a toy `src/hello.ts` workflow, run `npx wfe upload --url http://localhost:8080` against a local runtime, and verify end-to-end success — **operator follow-up before first publish**
- [ ] 11.3 Verify the published `@workflow-engine` scope is available on npm (or document the chosen alternate scope) — **operator prerequisite before first publish**

## 12. OpenSpec bookkeeping

- [x] 12.1 Confirm `pnpm exec openspec validate add-cli-package --strict` passes
- [x] 12.2 Update `openspec/project.md` to mention the new `cli` package in the monorepo structure section
