## 1. Pin pnpm version in `package.json`

- [x] 1.1 Add `"packageManager": "pnpm@11.0.9"` to the root `package.json`. Place it next to `"name"` / `"private"` / `"version"` (top of the file), before `"scripts"`.
- [x] 1.2 Confirm no other file declares a pnpm version that could conflict — grep the repo for `pnpm@`, `pnpm version`, and `version: 1[01]`. The only acceptable match after this change is `package.json#packageManager`. *(Verified — only `setup-pnpm/action.yml:8` had a real pin, handled by task 4.)*

## 2. Migrate `.npmrc` setting to `pnpm-workspace.yaml`

- [x] 2.1 In `pnpm-workspace.yaml`, add `injectWorkspacePackages: true` (top-level, sibling of `packages`, `allowBuilds`, `patchedDependencies`).
- [x] 2.2 Delete the root `.npmrc` file. Confirm it had no other content beyond `inject-workspace-packages=true`.
- [x] 2.3 Confirm no per-package `.npmrc` exists under `packages/*` or `workflows/`. *(Verified — none.)*

## 3. Add `core-js: false` to `allowBuilds`

- [x] 3.1 In `pnpm-workspace.yaml`, add `core-js: false` to the `allowBuilds` map (alphabetical position between `'@fission-ai/openspec'` and `esbuild`).
- [x] 3.2 Run `pnpm install` and confirm the `Ignored build scripts: core-js@<version>` warning is gone. *(Confirmed under pnpm 11.0.9 — no warning.)*

## 4. Bump `pnpm/action-setup` and drop the `version` arg

- [x] 4.1 In `.github/actions/setup-pnpm/action.yml`, change `pnpm/action-setup@v5` → `pnpm/action-setup@v6`.
- [x] 4.2 Remove the `with.version: 10` field. The action will read the pnpm version from `package.json#packageManager`.
- [x] 4.3 No other GitHub Action files reference `pnpm/action-setup` directly. *(Confirmed via `grep -rn "pnpm/action-setup" .github/` — the composite action under `.github/actions/setup-pnpm/` is the only entry point.)*

## 5. Regenerate the lockfile under pnpm 11

- [x] 5.1 Enable corepack locally / confirm pnpm 11 is active. *(`pnpm --version` reports `11.0.9`.)*
- [x] 5.2 Delete `node_modules` and per-workspace `node_modules` directories.
- [x] 5.3 Run `pnpm install` so v11 writes a fresh lockfile. *(Outcome was surprising and clean: pnpm 11 read the existing v9.0 lockfile, found the settings already aligned with `pnpm-workspace.yaml`, and produced **zero diff**. The actual fix was the `.npmrc` → workspace migration in task 2 — the lockfile content was already correct; only the *source* of the setting needed to move.)*
- [x] 5.4 Inspect the lockfile diff. *(No diff. `pnpm install --frozen-lockfile` succeeds clean.)*

## 6. Validate

- [x] 6.1 `pnpm validate` — green. **1489/1489 tests** + lint + typecheck + tofu fmt + tofu validate.
- [x] 6.2 `pnpm test:e2e` — green. **23/23 tests**.
- [x] 6.3 `pnpm test:wpt` — green. **23100/23100 passing** (24519 skipped per existing skip.json — same baseline as before).
- [x] 6.4 Boot `pnpm dev --random-port --kill`. Hit `/static/workflow-engine.css` (200), `/static/json-tree.js` (200), `/auth/local/signin` (302), `/invocations/local-user/demo-repo` (200). Tear down.
- [x] 6.5 Build the Docker image locally: `podman build -f infrastructure/Dockerfile -t pnpm-v11-smoke .` — succeeded to the production stage. *(One additional fix surfaced: `.dockerignore` excluded `**/dist` but not `**/*.tsbuildinfo`, so a stale host-side tsbuildinfo from a previous session got copied into the build context and caused `tsc --build` to skip emitting `dist/`. CI's clean checkout would not have the stale file, but local docker builds did. Added `**/*.tsbuildinfo` to `.dockerignore` as defensive hygiene — anyone validating this PR locally now gets a clean build.)*

## 7. Open the PR and verify CI

- [ ] 7.1 Push the branch and open a PR. Title: `chore(deps): upgrade pnpm to v11.0.9 and pin via packageManager`.
- [ ] 7.2 Watch the `docker-build` CI job — it MUST succeed.
- [ ] 7.3 Watch all other CI jobs (`ci`, `e2e`, `wpt`, `smoke-publish-shape`, `plan-infra`). They MUST continue to pass.
- [ ] 7.4 Once the PR merges, communicate the change in the team channel: contributors need `corepack enable` once and to rebase any open branches (lockfile will conflict for any branch that touches it; this PR's lockfile diff is empty, so most open branches won't conflict on `pnpm-lock.yaml` itself). Open PRs (e.g. `copy-button` / PR #232) should be rebased onto main.
