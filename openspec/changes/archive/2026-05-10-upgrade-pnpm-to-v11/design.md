## Context

Today three CI/dev surfaces resolve pnpm independently:

| Surface | How pnpm is selected | Resolves to today |
| --- | --- | --- |
| Local dev | Ambient PATH (whatever the contributor installed) | `pnpm 10.33.0` for the author |
| `ci` / `e2e` / `wpt` / `smoke-publish-shape` / `plan-infra` jobs | `.github/actions/setup-pnpm/action.yml` → `pnpm/action-setup@v5` with `version: 10` | `pnpm 10.x` (latest 10) |
| `docker-build` job | `infrastructure/Dockerfile:7` `RUN corepack enable` (no pin in `package.json`) | `pnpm 11.0.9` (corepack default = npm registry "latest" — picked up the pnpm 11 release on 2026-05-08) |

The lockfile carries `settings.injectWorkspacePackages: true` (a v10-shape setting; the pnpm 11 docs require this to live in `pnpm-workspace.yaml` instead). pnpm 11's frozen install refuses to proceed when the lockfile's settings shape doesn't match the current pnpm's expectations — `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. Separately, pnpm 11 turns `strictDepBuilds: true` on by default, and the workspace's `allowBuilds` map currently doesn't list `core-js` (a transitive whose postinstall is being silently ignored under v10 with a warning). The two together mean docker-build began failing on every PR the day after pnpm 11 shipped.

`pnpm/action-setup@v6.0.3+` is the v11-aware release (latest v6.0.6, 2026-05-08). v6 reads `packageManager` from `package.json` automatically when no `version` arg is passed, making the field the canonical pin.

`monorepo-structure/spec.md` describes the workspace layout but does not pin a pnpm version — exactly the contract that broke. `docker/spec.md` mandates `corepack-enabled pnpm` but stays version-agnostic, which is correct: the spec defers to `packageManager`. Adding the pin invariant to `monorepo-structure` is a single small spec delta; no other capability changes.

## Goals / Non-Goals

**Goals:**
- A single source of truth for pnpm version: `package.json#packageManager`. corepack (Dockerfile), `pnpm/action-setup` (CI), and contributor terminals all defer to it.
- Upgrade to pnpm 11.0.9 cleanly: lockfile rewritten under v11, `.npmrc` migrated, `allowBuilds` audited for the v11 strictness default.
- `docker-build` CI job green again on the next push to any PR.
- Spec layer encodes the contract that was implicit and broke (`monorepo-structure` Toolchain version pinning).
- All existing CI jobs continue to pass: `ci` (lint + check + test + tofu), `e2e`, `wpt`, `smoke-publish-shape`, `docker-build`, `plan-infra`.

**Non-Goals:**
- Migrating `pnpm publish` / `login` / `view` / `dist-tag` flows to v11's native implementations (we don't call them — the SDK ships via the existing `npm publish` GH workflow).
- Setting `minimumReleaseAge: 0` to opt out of the v11 24h supply-chain hold. Accept the default; revisit only if it actually blocks a release.
- Touching the `devEngines.node: ^25.9.0` vs `Dockerfile node:24-slim` drift. Pre-existing, separate scope.
- Auditing every `allowBuilds` entry. Only add `core-js: false` (the one v11 will fail on).
- Migrating any pnpm settings beyond what's necessary to make v11 happy with our lockfile.
- Switching dependency resolution mode (hoisting, isolation level, etc.).

## Decisions

### Decision 1: Path B (upgrade to v11), not Path A (pin v10)

Path A would pin `packageManager: pnpm@10.33.4`, leaving the lockfile and tooling untouched. It would unblock CI in one line. Rejected because it postpones the same drift event to the next pnpm major: `package.json` would be pinned to v10, but contributors running ambient pnpm (next year, on the latest installer) would see a different version locally than CI and Docker. Path B fixes the drift class, not just the symptom.

The cost differential is one line vs ~2k lines of lockfile rewrite. Reviewers absorb the lockfile diff once; the alternative is paying the same cost (plus a v10 → v11 migration) at an unknown future date with worse timing.

### Decision 2: `packageManager` is the single source of truth

Three pieces of config could declare the version:

| Where | Declares for | Status after this change |
| --- | --- | --- |
| `package.json#packageManager` | corepack everywhere; `pnpm/action-setup@v6` when no `version` arg | **canonical pin** |
| `.github/actions/setup-pnpm/action.yml#with.version` | only `pnpm/action-setup` | **dropped** (action reads `packageManager`) |
| Dockerfile env var or `corepack prepare pnpm@x --activate` | only the docker layer | **not used** (corepack reads `packageManager`) |

Single source of truth. Bumping the version (10 → 11.0.9, or any future bump) edits exactly one line of `package.json`.

### Decision 3: Migrate `.npmrc` setting to `pnpm-workspace.yaml`, delete `.npmrc`

`.npmrc` currently has one line: `inject-workspace-packages=true`. Under pnpm 11, non-auth/registry settings in `.npmrc` are removed — they must live in `pnpm-workspace.yaml`. The setting becomes `injectWorkspacePackages: true` in the workspace file. `.npmrc` becomes empty and is deleted.

Alternatives:
- Keep `.npmrc` empty as a placeholder for future auth/registry config: rejected — empty files are noise, contributors will populate it as needed.
- Leave the setting in `.npmrc` as-is: rejected — pnpm 11 ignores it there, so the `injectWorkspacePackages: true` we rely on (so workspace packages get injected into siblings during `pnpm deploy`) would silently flip off. This is a real behavioural impact: lockfile says it's enabled, runtime config says it isn't.

### Decision 4: `core-js: false` in `allowBuilds`

`pnpm install` under v10 already warns *"Ignored build scripts: core-js@3.49.0"*. Under v11's `strictDepBuilds: true` this becomes a hard error. We don't want core-js's postinstall (it prints donation banners and shells out — pure noise), so the right value is `false` (deny), not `true` (allow). Existing entries (esbuild, protobufjs, the four `@embedded-postgres/*` natives, `@fission-ai/openspec`) all stay at `true` and are unaffected.

A broader `allowBuilds` audit (does pnpm 11 detect more transitives with build scripts than v10 did?) is out of scope. If new ones surface during validation, add them targetedly; if many, that's a follow-up change.

### Decision 5: Bump `pnpm/action-setup@v5 → @v6` and drop the `version` arg

v6 supports pnpm 11. v5 will not work because v5's bundled pnpm CLI rejects v11 lockfile-shape changes. Dropping `with.version: 10` makes the action defer to `packageManager` from `package.json`, completing the single-source-of-truth model.

`actions/setup-node@v6` (the cache step) is unchanged — it caches the pnpm store via the `cache: pnpm` flag, which is version-agnostic.

### Decision 6: Spec delta — single new requirement on `monorepo-structure`

Add **Requirement: Toolchain version pinning** to `monorepo-structure/spec.md`. The text:

> The root `package.json` SHALL declare a `packageManager` field (e.g. `"packageManager": "pnpm@11.0.9"`) so that `corepack`, `pnpm/action-setup`, and contributor terminals resolve a single deterministic pnpm version across local development, CI, and the Docker build.

Three scenarios cover (a) corepack honouring the pin in Dockerfile, (b) `pnpm/action-setup` reading the pin when no `version` arg is set, (c) the field being present and pointing at a specific minor version (not just `pnpm@*`).

`docker/spec.md` and `ci-workflow/spec.md` are unchanged. They already say "corepack-enabled pnpm" / "use pnpm" without pinning a version, which is correct: they defer to `packageManager`. Touching them just to add cross-references would be churn.

## Risks / Trade-offs

- **Lockfile diff size (~2k lines)** → Mitigation: bundle the lockfile rewrite alone in this PR; no code changes ride along. Reviewers can scan the settings header + a few sample resolutions and trust the rest. Validation matrix (`pnpm validate`, `test:e2e`, `test:wpt`, dev probes, local docker build) provides empirical confidence.
- **Contributor friction (one-time `corepack enable`)** → Mitigation: corepack ships with Node ≥16 (we're on 24), so `corepack enable` is a one-command setup. Document in `CLAUDE.md` if needed; otherwise contributors hit a clear pnpm error on first install and the fix is googleable.
- **Open PRs need to rebase + regenerate lockfile** → Mitigation: copy-button (PR #232) and any other open PRs will conflict on `pnpm-lock.yaml`. Each owner regenerates with `pnpm install` after rebase. Cost is real but bounded; communicating the upgrade timing helps.
- **`minimumReleaseAge: 1440` could block urgent dep updates** → Mitigation: `--frozen-lockfile` skips live resolution, so CI/Docker installs are unaffected. Only `pnpm add`/`pnpm update` runs touch this. If we hit a real "need this dep within 24h of release" case (rare), opt out per-command with `--minimum-release-age=0` rather than globally; or set `minimumReleaseAge: 0` in `pnpm-workspace.yaml` if it becomes a recurring blocker.
- **`strictDepBuilds: true` may surface new build-script-bearing transitives** → Mitigation: validate locally before pushing. If new ones appear beyond `core-js`, add them to `allowBuilds` as part of this change; if more than a handful, split into a follow-up.
- **`pnpm/action-setup@v6` itself could regress** → Mitigation: v6.0.6 is the latest stable as of 2026-05-08; pinning the major (`@v6`) lets the action self-update for patches without breaking on a major bump. If a v6 patch breaks something, pin to `@v6.0.6` exactly. This is the same risk we run with any GitHub Action version.
- **SQLite-backed store v11** → first install on a contributor machine re-fetches the entire store. Slow once, then back to fast. CI buildkit caches will miss on the `pnpm fetch` layer the first time; subsequent builds return to cached behaviour.
- **`docker-build` failure persists if the upgrade goes wrong** → Mitigation: include a local docker build (`docker build -f infrastructure/Dockerfile .`) in the validation tasks before PR. Cheap to run locally; catches Dockerfile issues that CI would otherwise flag late.
