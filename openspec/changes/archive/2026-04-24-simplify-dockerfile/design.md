## Context

Today's `infrastructure/Dockerfile` builds the runtime image in two stages. Stage 1 (on `node:24-slim`) installs pnpm deps, runs two `vite build` passes, and materialises a deployable tree via `pnpm deploy --prod --shamefully-hoist`. Stage 2 (on `gcr.io/distroless/nodejs24-debian13`) copies that tree and sets the entry point.

Stage 1 hand-enumerates every workspace `package.json`, `tsconfig.json`, `vite.config.ts`, and `src/` tree in order to keep the `pnpm install --frozen-lockfile` step in a cache layer separate from the source layer. The enumeration is load-bearing for caching, but fragile:

- Adding a new workspace package (e.g. a future `@workflow-engine/cli-v2`) requires a Dockerfile edit that is easy to forget and produces opaque `pnpm install` errors.
- Adding a new top-level config file consumed by vite builds (`biome.json`, new `tsconfig.*.json`, etc.) likewise silently breaks stage 1 until the COPY block is updated.
- The ordering constraints between `patches/`, `pnpm-lock.yaml`, and the workspace `package.json` files are encoded in comments rather than in a single declarative input.

pnpm ships a documented monorepo-Docker pattern (`pnpm fetch`) that populates the store from `pnpm-lock.yaml` alone, decoupling dep download from both workspace enumeration and source trees.

## Goals / Non-Goals

**Goals:**

- Eliminate the class of breakages caused by adding a workspace package or top-level config without touching the Dockerfile.
- Preserve the dependency-install-layer cache behaviour (invalidate only when the dep closure changes, not when source changes).
- Keep stage-2 image contents byte-identical in intent (same `main.js`, same native externals, same worker).
- Keep the change auditable in a single small PR; no OpenSpec capability spec delta.

**Non-Goals:**

- Shrink the final image (the orthogonal option — dropping `pnpm deploy --prod --shamefully-hoist` and hand-assembling `/app/deploy` around the known externals — is a separate follow-up).
- Add a buildkit `--mount=type=cache` for the pnpm store (CI's existing `cache-from/to: type=gha,mode=max` already gives us the common-case win; deferred until it's paying rent).
- Pin the pnpm version via `packageManager` (desirable but unrelated).
- Touch any other Dockerfile in the repo (none exist today anyway).

## Decisions

### Decision 1 — pnpm fetch for the dep layer

Replace the enumerated-COPY block with:

```dockerfile
COPY pnpm-lock.yaml ./
RUN pnpm fetch
```

`pnpm fetch` reads **only** `pnpm-lock.yaml` and populates the pnpm content-addressed store. No workspace package.jsons, no `.npmrc`, no `pnpm-workspace.yaml` needed at this step. Downstream `pnpm install --offline --frozen-lockfile` resolves entirely from the pre-populated store.

**Alternatives considered:**

- **`turbo prune` / `nx prune`**: emit a minimal subset of the monorepo. Overkill for a drift problem; introduces a new tool and a new pruning step to maintain.
- **Single `COPY . .` with enumerated `pnpm install --filter` list**: doesn't help — still requires enumeration.
- **Glob-ed COPY (`COPY packages/*/package.json packages/*/`)**: Dockerfile's COPY does not preserve source directory structure when multiple paths are globbed to a single destination; the target would be flat, breaking pnpm. pnpm fetch sidesteps the problem entirely.

### Decision 2 — `COPY . .` + denylist `.dockerignore`

After `pnpm fetch`, copy the entire build context in one line. Narrow the context via a denylist `.dockerignore`:

```
.git
.github
.claude
.vscode
node_modules
**/node_modules
**/dist
workflows
infrastructure
openspec
scripts
packages/sandbox-stdlib/test
```

**Why denylist over keeping today's allowlist:** the allowlist bakes the same enumeration problem into `.dockerignore` — a new workspace package needs a new `!packages/<name>/` line. The denylist only grows when something *new* needs to be excluded, which is rare (large vendored dirs, ephemeral state).

**Why `workflows/` is excluded safely:** `pnpm-workspace.yaml` lists `workflows` as a member, but the current Dockerfile already omits `workflows/package.json` from stage 1 and `pnpm install --frozen-lockfile` succeeds — pnpm is tolerant of absent workspace dirs. The runtime image needs nothing from `workflows/`.

**Why `packages/sandbox-stdlib/test` stays excluded:** it contains the vendored WPT suite (large), matching today's behaviour.

### Decision 3 — `pnpm -r build` instead of two explicit `vite build` invocations

Root `package.json` already defines `"build": "pnpm -r build"`. pnpm's `-r` runs workspace builds in topological order, so `@workflow-engine/sandbox` builds before `@workflow-engine/runtime`, which is the order the current Dockerfile hardcodes. One line, self-updating when packages are added.

**Alternative considered:** keep `pnpm --filter @workflow-engine/sandbox exec vite build` then `pnpm --filter @workflow-engine/runtime exec vite build`. Explicit but reintroduces per-package enumeration.

### Decision 4 — Keep `pnpm deploy --prod --shamefully-hoist`

The stage-2 payload assembly is left unchanged. It's independent of the drift problem and changing it expands blast radius. The follow-up "hand-assemble with only the known externals" is tracked as a non-goal here.

## Risks / Trade-offs

- **[Risk]** `pnpm fetch` requires pnpm's store-dir to match between fetch and install. → **Mitigation:** both run in the same `WORKDIR /app` against the default corepack-managed pnpm, which uses the same store-dir throughout the stage. No explicit `store-dir` override needed.
- **[Risk]** `pnpm install --offline --frozen-lockfile` fails if any dep is missing from the pre-populated store. → **Mitigation:** the lockfile is the single source of truth for both fetch and install, so this can only happen if someone edits `pnpm-lock.yaml` between the two steps — not possible inside a single stage.
- **[Risk]** `.dockerignore` denylist lets a stray large file in the repo root (e.g. a future `benchmarks/` dir) silently bloat the build context. → **Mitigation:** low-impact; adding a new exclude line is a one-line fix when it comes up. The allowlist's rigidity is a higher ongoing cost.
- **[Risk]** Root `postinstall` runs `tofu … init` wrapped in `|| true`. In the distroless builder there is no `tofu`; the `|| true` swallows the failure. → **Mitigation:** unchanged behaviour from today — the current Dockerfile also runs `pnpm install` and relies on the same `|| true` escape hatch.
- **[Trade-off]** `COPY . .` makes the source-change → install-or-build layer granularity coarser than today's per-src COPY. In practice today's install layer only invalidates on `package.json` changes, and the new `COPY pnpm-lock.yaml` + `pnpm fetch` layer preserves that property on the more expensive (network) step. The slightly-coarser source layer only affects `pnpm install --offline` re-run speed, which is near-instant from the populated store.
- **[Trade-off]** `pnpm -r build` will also execute build scripts in any new workspace package that defines `"build"`. Today the only workspaces with `build` scripts are `sandbox` and `runtime`; `workflows` has no `build` script in this image's context (and is excluded anyway). A future package adding a `build` script is a *feature* here, not a regression.

## Migration Plan

Single PR, single merge:

1. Rewrite `infrastructure/Dockerfile` per the design above.
2. Rewrite `.dockerignore` as a denylist.
3. Local verification: `pnpm local:up:build` succeeds; the resulting image starts; `kubectl get pods -n workflow-engine` shows the runtime serving.
4. Merge to `main` → `deploy-staging.yml` runs a cold build + push + apply. Verify staging endpoint up.
5. Cherry-pick to `release` → `deploy-prod.yml` runs same path behind approval gate. Verify prod.

**Rollback:** `git revert` the PR. No runtime-visible state to unwind; no tenant re-upload; image tag/digest handling in OpenTofu is unchanged.
