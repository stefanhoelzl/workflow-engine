## Why

`infrastructure/Dockerfile`'s stage-1 enumerates every workspace `package.json`, `tsconfig.json`, `vite.config.ts`, and `src/` directory as individual `COPY` statements. Adding a new workspace package, a new top-level config file, or renaming a source tree requires remembering to edit the Dockerfile; in practice it drifts and breaks builds until someone notices. The enumeration exists only to keep `pnpm install --frozen-lockfile` in its own cache layer — there is a pnpm-native pattern (`pnpm fetch`) that achieves the same layer caching without per-package enumeration.

## What Changes

- Replace the enumerated COPY block (lines 9-34 of `infrastructure/Dockerfile`) with the pnpm-recommended monorepo pattern: `COPY pnpm-lock.yaml` → `pnpm fetch` → `COPY . .` → `pnpm install --offline --frozen-lockfile`.
- Replace the two per-package `vite build` invocations with a single `pnpm -r build` (pnpm builds workspace packages in topological order).
- Convert `.dockerignore` from an allowlist (`*` + `!packages/core/` + …) to a denylist that excludes `workflows/`, `infrastructure/`, `openspec/`, `scripts/`, `.github/`, `.claude/`, `.vscode/`, `.git/`, `**/node_modules`, `**/dist`, and `packages/sandbox-stdlib/test/`.
- Keep `pnpm deploy --prod --shamefully-hoist --filter @workflow-engine/runtime /app/deploy` and the `cp -r packages/runtime/dist/* /app/deploy/` step unchanged — the stage-2 payload shape is preserved.
- No change to the production stage (`gcr.io/distroless/nodejs24-debian13`), `USER 65532`, `EXPOSE 8080`, or `CMD`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `docker`: Add two requirements that codify the anti-drift guarantee — (1) the dependency install layer SHALL be keyed to `pnpm-lock.yaml` alone (no per-workspace `COPY` enumeration), and (2) workspace builds SHALL run via `pnpm -r build` relying on topological ordering. The existing requirement ("multi-stage build, node:24-slim, pnpm deploy --prod, distroless stage-2") is satisfied unchanged by the new implementation. Image contents, entry point, user, port, and multi-stage topology stay identical.

## Impact

- **Files touched**: `infrastructure/Dockerfile`, `.dockerignore`.
- **Build behaviour**: Layer caching switches from "invalidate on any `packages/*/package.json` change" to "invalidate on any `pnpm-lock.yaml` change" for the dependency layer. Install+build layer invalidates on any source change (unchanged from today for practical purposes).
- **CI**: `.github/actions/docker-build/action.yml` already uses buildx + `cache-from/to: type=gha,mode=max`, so the new layer shape is cached across runs without any workflow edit.
- **Image contents**: Byte-identical intended output — same `dist/main.js`, same `node_modules/@duckdb/node-bindings`, same `quickjs-wasi`, same `sandbox/dist/src/worker.js`.
- **No tenant re-upload, no state wipe, no upgrade note** beyond a one-line entry in `CLAUDE.md` for operator awareness.
- **Rollback**: `git revert` — no runtime-visible change to undo.
