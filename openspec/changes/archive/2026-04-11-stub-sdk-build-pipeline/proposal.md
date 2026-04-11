## Why

The Vite plugin currently extracts action handler bodies from bundled code using regex and brace-matching, then emits them as bare function files (`export default async (ctx) => { ... }`). This breaks when handlers import npm libraries — the regex only grabs the function body, losing bundled imports at module scope. The sandbox also relies on stripping `export default` and wrapping the result as a function expression, which prevents evaluating proper ES modules.

## What Changes

- **Vite plugin**: Replace regex handler extraction with a single `vite.build()` per workflow using a stub SDK plugin. The stub replaces `@workflow-engine/sdk` during the per-action build so Zod/SDK code (~128KB) is eliminated from the output. The workflow `.ts` file is used directly as the build entry. Output is one `actions.js` per workflow (~2.3KB) containing all action handlers as named exports.
- **Manifest format**: **BREAKING** — `module` moves from per-action to the manifest top level. Each action gains an `export` field naming its handler export in the module.
- **Sandbox evaluation**: Replace regex-based `export default` stripping + function expression eval with `evalCode(source, filename, { type: "module" })` and named export extraction via `getProp(exports, exportName)`.
- **Metadata extraction**: Replace temp-file-write + dynamic `import()` with `tsImport()` from `tsx/esm/api` to import workflow `.ts` sources directly for `compile()` metadata.
- **Action data model**: `Action.source` moves to the workflow level. `Action` gains `exportName` for sandbox extraction.

## Capabilities

### New Capabilities

_(none — this is a replacement of internal mechanisms, not new user-facing capability)_

### Modified Capabilities

- `vite-plugin`: Per-action regex extraction replaced with single stub-SDK Vite build per workflow. Output changes from N per-action files to one `actions.js` with named exports.
- `workflow-manifest`: `module` field moves from per-action to manifest top level. Actions gain `export` field. **BREAKING** format change.
- `sandbox`: Evaluation changes from function expression (`(async (ctx) => {...})`) to ES module evaluation with named export extraction.
- `workflow-loading`: Action data model changes — `source` moves to workflow level, `exportName` added to actions. Registry and scheduler threading updated.

## Impact

- **Packages**: `@workflow-engine/vite-plugin`, `@workflow-engine/sdk` (ManifestSchema), `packages/runtime` (sandbox, actions, workflow-registry, scheduler)
- **Build output**: `dist/<workflow>/actions/*.js` replaced by `dist/<workflow>/actions.js`
- **Manifest format**: Breaking change — existing bundles incompatible with new runtime
- **Dependencies**: No new dependencies. `tsx` (existing root devDep) used for metadata extraction. `vite` (existing peer dep) used for programmatic builds.
- **Tests**: Sandbox tests unchanged (export default still works via default exportName). Integration and scheduler tests need `exportName` field on mock actions.
