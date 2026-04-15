## Why

Today, the only way to upload a workflow bundle to the runtime is a hand-rolled `fetch` call inside `scripts/dev.ts`, hardcoded to `localhost:8080` and gated by the `__DISABLE_AUTH__` sentinel. There is no user-facing tool for building and uploading workflows, and the SDK + vite-plugin are marked `private` — external users cannot author workflows against a deployed runtime.

To make the runtime usable by anyone with a deployment, we need a published CLI (`wfe`) that builds a workflow project and uploads its bundles to a target runtime, plus publishing the SDK and vite-plugin packages that the CLI depends on.

## What Changes

- **NEW** `packages/cli/` workspace → published as `@workflow-engine/cli` with a `wfe` binary
  - `wfe upload [--url <url>]` — discovers workflows, builds, uploads; one-shot, no watch
  - Exports a programmatic `upload()` function so `scripts/dev.ts` can call it without spawning a subprocess
  - Ships a bundled default vite config; users do not author `vite.config.ts`
  - Built on `citty` for argv parsing
- **BREAKING** `@workflow-engine/vite-plugin`: remove the `workflows: string[]` option; plugin now auto-discovers workflow entry files at `<root>/src/*.ts` (non-recursive); fails the build loudly when the directory is missing or empty
- **BREAKING** Workflow project layout: workflow entry files must live at `<root>/src/<name>.ts` (one file per workflow). Existing `workflows/cronitor.ts` migrates to `workflows/src/cronitor.ts`, and `workflows/vite.config.ts` is deleted
- **Publishing**: `@workflow-engine/sdk`, `@workflow-engine/vite-plugin`, and `@workflow-engine/cli` drop `"private": true` and share a common version; published manually via `pnpm -r publish`
- Runtime: `POST /api/workflows` 422 responses now include a structured `error` string (the registry's failure reason), and manifest-validation failures additionally include an `issues` array with Zod-style path/message entries, so the CLI can show actionable errors
- `scripts/dev.ts` is rewritten to TCP-poll the runtime port, import `{ upload }` from `@workflow-engine/cli`, and watch `workflows/src/**/*.ts` recursively (rebuild + re-upload all workflows on any change)

## Capabilities

### New Capabilities

- `cli`: The `wfe` command-line tool — discovery of `src/*.ts`, build via the shipped vite config, `GITHUB_TOKEN`-based auth, URL resolution (flag + default), per-bundle upload with best-effort semantics, exit codes, and structured error output
- `vite-plugin`: The `@workflow-engine/vite-plugin` build contract — auto-discovery of workflow entries at `<root>/src/*.ts`, emitted artifacts (`dist/<name>/{manifest.json,actions.js,bundle.tar.gz}`), and the error behavior when no workflows are found

### Modified Capabilities

- `action-upload`: 422 response body contract is tightened — it MUST include a specific `error` string, and manifest-validation failures MUST additionally include `issues: Array<{path, message}>`

## Impact

**Code**:
- NEW package: `packages/cli/` (citty entry, programmatic `upload()`, `build()`, shipped vite config)
- MODIFIED: `packages/vite-plugin/src/index.ts` (drop `WorkflowPluginOptions.workflows`, add discovery)
- MODIFIED: `packages/runtime/src/api/upload.ts` (forward registry error + zod issues in 422 body)
- MODIFIED: `packages/runtime/src/workflow-registry.ts` (propagate zod issues from manifest parse)
- MODIFIED: `scripts/dev.ts` (TCP poll + programmatic `upload()` + recursive watch)
- MIGRATION: `workflows/cronitor.ts` → `workflows/src/cronitor.ts`; delete `workflows/vite.config.ts`; update `workflows/package.json` (drop direct vite-plugin dep + `build` script, add `@workflow-engine/cli`)

**Packages published to npm** (new surface):
- `@workflow-engine/sdk`
- `@workflow-engine/vite-plugin`
- `@workflow-engine/cli`

`@workflow-engine/runtime` and `@workflow-engine/sandbox` stay private (runtime ships as a container image; sandbox is a runtime-only internal).

**Dependencies**:
- New runtime deps for the CLI: `vite`, `citty`, `@workflow-engine/vite-plugin`
- External users install: `@workflow-engine/sdk` (workflow authoring) and `@workflow-engine/cli` (devDep) — vite + plugin come transitively with the CLI

**Operational**:
- `@workflow-engine` npm scope must be registered (or an alternate scope chosen before first publish)
- `pnpm dev` flow unchanged from the user's perspective, but its mechanics move into the CLI

**Security**: No change to the sandbox boundary, no new server-side surface (server still exposes only `POST /api/workflows`), no change to `github-auth` behavior. The runtime 422 body becomes slightly more verbose but still returns only what the registry already logged internally.
