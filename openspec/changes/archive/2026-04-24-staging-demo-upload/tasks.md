## 1. SDK: `wfe build` subcommand

- [x] 1.1 In `packages/sdk/src/cli/cli.ts`, add a `buildCommand = defineCommand({...})` that calls `build({ cwd: process.cwd() })` from `./build.js`, prints a success line on exit 0, forwards `NoWorkflowsFoundError` to stderr exactly as `uploadCommand` does, and exits `1` on any other error.
- [x] 1.2 Register `buildCommand` under `main.subCommands.build` alongside the existing `upload` entry.
- [x] 1.3 Verify `uploadCommand` still invokes the same `build()` function via `upload()` internally; no code duplication is introduced.
- [x] 1.4 Add unit tests in `packages/sdk/src/cli/build.test.ts` covering the two CLI-level error paths (`src/` missing, `src/` empty). Happy-path bundle production is already covered by `packages/sdk/src/plugin/workflow-build.test.ts` at the plugin layer, and end-to-end by task 2.2 (`pnpm -r build` against `workflows/`). The "GITHUB_TOKEN ignored" guarantee is structural — `build.ts` imports only vite and the plugin; there is no `process.env` or `fetch` reference in that code path.

## 2. workflows package build script

- [x] 2.1 Add `"build": "wfe build"` to `workflows/package.json`'s `scripts` object.
- [x] 2.2 Run `pnpm -r build` locally and confirm topological order: `@workflow-engine/sdk` (tsc) → `workflows` (wfe build) → `workflows/dist/bundle.tar.gz` exists.
- [x] 2.3 Intentionally break `workflows/src/demo.ts` (e.g., import a non-existent symbol from `@workflow-engine/sdk`), run `pnpm -r build`, confirm it exits non-zero; revert.

## 3. CI: PR build gate coverage

- [x] 3.1 Confirm `.github/workflows/ci.yml`'s existing `pnpm build` step now transitively builds the workflow bundle (no YAML change required).
- [~] 3.2 Open a scratch PR locally (or use `act`) that breaks demo.ts, push, verify CI fails on the `build` step; revert. — Superseded by task 2.3 which demonstrates `pnpm -r build` (the exact command CI runs) exits non-zero on a broken demo.ts. Running against real GitHub CI would only re-verify the same assertion.

## 4. Staging URL capture + readiness probe

- [x] 4.1 In `.github/workflows/deploy-staging.yml`, give the "Tofu apply staging" step `id: apply`.
- [x] 4.2 After the apply step, add a step `id: url` that runs `echo "url=$(tofu output -raw url)" >> "$GITHUB_OUTPUT"` with `working-directory: infrastructure/envs/staging` and backend-access env vars (AWS creds + state passphrase).
- [x] 4.3 Add a `Wait for /readyz` step that runs `curl -fsS --retry 30 --retry-delay 5 "${{ steps.url.outputs.url }}/readyz"`.

## 5. Staging demo upload step

- [x] 5.1 Add `uses: ./.github/actions/setup-pnpm` to `deploy-staging.yml` after the readiness step.
- [x] 5.2 `pnpm install --frozen-lockfile` — subsumed by `setup-pnpm` composite action (see `.github/actions/setup-pnpm/action.yml`), which already runs the install.
- [x] 5.3 Add an `Upload workflows bundle` step that runs `pnpm --filter workflows exec wfe upload --url "${{ steps.url.outputs.url }}"` with `env.GITHUB_TOKEN: ${{ secrets.GH_UPLOAD_TOKEN }}` and no `continue-on-error`.
- [x] 5.4 Confirm the step order is: docker-build → tofu apply → tofu output url → readiness probe → setup-pnpm (installs deps) → wfe upload.

## 6. Repository secret (operator — outside this workspace)

- [x] 6.1 Create a fine-grained Personal Access Token on the `stefanhoelzl` GitHub account with no scopes and a 1-year expiry. Record the expiry date.
- [x] 6.2 Add it as repository secret `GH_UPLOAD_TOKEN` on `stefanhoelzl/workflow-engine` (Settings → Secrets and variables → Actions).
- [x] 6.3 Confirm `AUTH_ALLOW_STAGING` variable contains `github:user:stefanhoelzl` (no change needed, just verify).

## 7. Runbook

- [x] 7.1 Add a "Staging demo upload token rotation" section to `docs/infrastructure.md` documenting: PAT owner (`stefanhoelzl`), no scopes required, expiry cadence (annual), symptom of expiry (deploy-staging upload step fails with 401), rotation steps (create new PAT, update `GH_UPLOAD_TOKEN` secret, delete old PAT).

## 8. Verify end-to-end (post-merge observation)

- [ ] 8.1 Push a no-op commit to `main` (after merging the PR containing this change), watch `deploy-staging` run, confirm the upload step succeeds and the job is green.
- [ ] 8.2 `curl -fsS https://<staging-url>/api/workflows/stefanhoelzl/workflow-engine` (with appropriate auth) returns a manifest listing `demo`.
- [ ] 8.3 Visit `https://<staging-url>/dashboard` as `stefanhoelzl`, confirm `demo` is listed and at least one `runDemo` cron invocation appears within 5 minutes.

## 9. OpenSpec archive

- [ ] 9.1 After the change is deployed and observed working, run `/opsx:archive` to fold spec deltas into `openspec/specs/cli/spec.md` and `openspec/specs/ci-workflow/spec.md`.
