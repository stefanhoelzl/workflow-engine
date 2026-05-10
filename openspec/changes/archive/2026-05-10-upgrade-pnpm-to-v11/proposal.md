## Why

The repo runs on three different pnpm versions today: local dev uses whatever's on PATH (currently 10.33.0), CI lint/test/e2e/wpt jobs use pnpm 10 via `pnpm/action-setup@v5` (`version: 10`), and the `docker-build` CI job uses `corepack enable` with no pin — which now resolves to the latest pnpm release on every build. pnpm 11 shipped on 2026-05-08, and the next docker-build picked it up automatically; under pnpm 11 the lockfile's `injectWorkspacePackages: true` setting (a v10 settings shape) plus a missing `core-js` entry in `allowBuilds` make `pnpm install --offline --frozen-lockfile` fail. PR builds have been blocked since.

Pinning to v10 would unblock today, but only delays the same drift event the next time a pnpm major ships. Upgrading to v11 — and pinning the version explicitly via `package.json#packageManager` so corepack, `pnpm/action-setup`, and local dev resolve a single deterministic version — fixes both the immediate failure and the underlying class of bug.

## What Changes

- The root `package.json` declares `"packageManager": "pnpm@11.0.9"`. corepack and `pnpm/action-setup@v6` both honour this field, giving every surface a single source of truth.
- `.npmrc` is deleted. Its only setting (`inject-workspace-packages=true`) moves to `pnpm-workspace.yaml` as `injectWorkspacePackages: true` — pnpm 11 enforces "settings live in `pnpm-workspace.yaml`, not `.npmrc`".
- `pnpm-workspace.yaml` adds `core-js: false` to `allowBuilds`. core-js is a transitive dependency whose postinstall script is currently *ignored* (warning under v10, hard failure under v11's `strictDepBuilds: true` default). Explicit denial silences the warning and pre-empts the v11 failure.
- `.github/actions/setup-pnpm/action.yml` bumps `pnpm/action-setup@v5` → `@v6` (the v11-aware release) and drops its `with.version: 10` field — the action now reads `packageManager` from `package.json`.
- `pnpm-lock.yaml` is regenerated under pnpm 11 (`lockfileVersion: 9.0` → `10.0`; index-file integrity strings move to hex digests; possible transitive resolution shifts from any peer-dep logic changes).
- **BREAKING for contributors**: anyone running locally needs corepack-enabled `pnpm@11` after this lands. With the `packageManager` pin in place, `corepack enable` (one-time) plus `pnpm <command>` is enough — corepack auto-fetches the pinned version on first invocation. Open PRs against main will need to rebase and regenerate the lockfile.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `monorepo-structure`: gains a new requirement — *Toolchain version pinning* — stating the root `package.json` SHALL declare `packageManager` so corepack, `pnpm/action-setup`, and local dev resolve a single deterministic pnpm version. This encodes the contract that was implicitly broken when pnpm 11 shipped without our consent, and prevents recurrence on the next major.

## Impact

- **Code/config**: `package.json` (add `packageManager`); `.npmrc` (delete); `pnpm-workspace.yaml` (add `injectWorkspacePackages`, add `core-js: false`); `.github/actions/setup-pnpm/action.yml` (bump action version, drop `version` arg); `pnpm-lock.yaml` (regenerated, ~2k+ line diff).
- **CI / Docker**: `infrastructure/Dockerfile` is unchanged structurally — `corepack enable` already does the right thing once `packageManager` is set. `docker-build` starts succeeding again. All other CI jobs continue to pass; the `setup-pnpm` action change is internal.
- **Deps / sandbox / EventBus / manifest**: unaffected. This is a build-tooling change with no runtime surface.
- **Contributors**: one-time `corepack enable` after pulling. Open PRs need to rebase and regenerate the lockfile. Documented in the change.
- **Security defaults inherited from v11**:
  - `minimumReleaseAge: 1440` (1 day) — newly published packages aren't resolved for 24h. We use `--frozen-lockfile` everywhere relevant, so installs are unaffected; only `pnpm add`/`pnpm update` runs interact with this.
  - `strictDepBuilds: true` — handled by the `core-js: false` addition above. Existing `allowBuilds` entries (esbuild, protobufjs, embedded-postgres natives, openspec) carry over.
  - `blockExoticSubdeps: true` — no exotic (git/file/url) subdeps in the workspace, so no impact.
- **Out of scope** (explicitly):
  - Migrating `pnpm publish` / `login` / `view` flows. We don't use them — the SDK ships via the existing `npm publish` workflow.
  - The `devEngines.node: ^25.9.0` vs `Dockerfile node:24-slim` drift (pre-existing; tracked separately).
  - Setting `minimumReleaseAge: 0` to opt out of the 24h hold. Accept the v11 default; revisit if it bites in practice.
  - Any per-package allowBuilds re-audit beyond the core-js addition.
