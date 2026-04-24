## Why

Staging currently ships a fresh runtime on every push to `main`, but no workflows are ever uploaded — so there is nothing to exercise executor, event store, dashboard, or trigger UI surfaces end-to-end. At the same time, breakage in the workflow bundle build (`demo.ts` or any SDK surface demo.ts exercises) is invisible on PRs: `pnpm -r build` reaches every workspace that defines a `build` script, but `workflows/package.json` has none, so the bundle is silently skipped in CI. Faults only surface when a human runs `pnpm upload` locally.

## What Changes

- Add a `wfe build` subcommand to the SDK CLI that invokes the existing internal build pipeline (`packages/sdk/src/cli/build.ts`) without uploading. Authenticated network I/O is NOT part of this subcommand.
- Add `"build": "wfe build"` to `workflows/package.json`. This makes the bundle build participate in `pnpm -r build`, so the existing `pnpm build` step in `.github/workflows/ci.yml` now fails PRs when the bundle fails to build.
- Extend `.github/workflows/deploy-staging.yml` with post-apply steps that (a) capture the staging URL from `tofu output -raw url`, (b) poll `/readyz` until the rollout is live, (c) install pnpm dependencies, (d) run `wfe upload --url <staging-url>` against `stefanhoelzl/workflow-engine` authenticated via a new `GH_UPLOAD_TOKEN` secret. Upload failure fails the job.
- Add a new repository secret `GH_UPLOAD_TOKEN` (fine-grained PAT owned by `stefanhoelzl`). `AUTH_ALLOW_STAGING` is unchanged because it already permits `github:user:stefanhoelzl`.
- Runbook note in `docs/infrastructure.md` documenting PAT rotation cadence.

No changes to prod deploy. No app-side code changes. No changes to `SECURITY.md` invariants.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `cli`: `wfe` gains a `build` subcommand; upload's build phase is factored so both paths share the same implementation.
- `ci-workflow`: staging deploy additionally uploads the monorepo's `workflows/` bundle to the freshly-deployed runtime, gated on a `/readyz` readiness probe; PR validation now covers workflow bundle build via `pnpm -r build`.

## Impact

- **CLI surface**: `wfe build` is new. Existing `wfe upload` behaviour is unchanged except that its build phase is shared with `wfe build`.
- **CI/CD**: `ci.yml` unchanged (new coverage comes automatically from `pnpm -r build` finding a `build` script under `workflows/`). `deploy-staging.yml` gains ~4 steps (setup-pnpm, install, readiness probe, upload).
- **Repository secrets**: one addition (`GH_UPLOAD_TOKEN`).
- **Runtime / sandbox / persistence**: untouched.
- **Staging traffic**: demo.ts's `everyFiveMinutes` cron will run continuously on staging, producing a steady stream of `invocation.started` / `invocation.completed` events. This is ambient smoke-signal traffic; no alerting wired.
- **Ownership**: demo workflow lives under `stefanhoelzl/workflow-engine` on staging (auto-detected from git remote). Any human upload to the same `(owner, repo)` scope on staging would be overwritten by the next deploy.
