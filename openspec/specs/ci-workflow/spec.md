## Purpose

GitHub Actions workflows that validate pull requests and deploy staging on push to `main`.
## Requirements
### Requirement: PR validation workflow
The system SHALL provide a GitHub Actions workflow at `.github/workflows/ci.yml` that runs on every pull request.

#### Scenario: PR opened or updated
- **WHEN** a pull request is opened, synchronized, or reopened
- **THEN** the workflow SHALL run lint, type check, test, and build steps in sequence

### Requirement: Lint step
The workflow SHALL run `pnpm lint` to validate code with Biome.

#### Scenario: Lint passes
- **WHEN** all source files conform to Biome lint rules
- **THEN** the step SHALL succeed and proceed to the next step

#### Scenario: Lint fails
- **WHEN** any source file violates Biome lint rules
- **THEN** the step SHALL fail and the workflow SHALL report failure

### Requirement: Type check step
The workflow SHALL run `pnpm check` to validate TypeScript types.

#### Scenario: Type check passes
- **WHEN** all TypeScript files pass strict type checking
- **THEN** the step SHALL succeed and proceed to the next step

#### Scenario: Type check fails
- **WHEN** any TypeScript type error exists
- **THEN** the step SHALL fail and the workflow SHALL report failure

### Requirement: Test step
The workflow SHALL run `pnpm test` to execute the test suite via Vitest.

#### Scenario: Tests pass
- **WHEN** all tests pass
- **THEN** the step SHALL succeed and proceed to the next step

#### Scenario: Tests fail
- **WHEN** any test fails
- **THEN** the step SHALL fail and the workflow SHALL report failure

### Requirement: Build step
The workflow SHALL run `pnpm build` to produce the production build via Vite. `pnpm build` is aliased to `pnpm -r build`, which SHALL include the `workflows` workspace's bundle build (`wfe build`). A failure to build `workflows/src/demo.ts` or any SDK surface it exercises SHALL fail the PR validation workflow.

#### Scenario: Build succeeds
- **WHEN** every workspace's build (including the `workflows` bundle build) completes without errors
- **THEN** the step SHALL succeed and the workflow SHALL report success

#### Scenario: Build fails
- **WHEN** any workspace's build fails (including a regression that breaks `workflows/src/demo.ts`)
- **THEN** the step SHALL fail and the workflow SHALL report failure

#### Scenario: Workflow bundle build is covered
- **GIVEN** `workflows/package.json` declares `"build": "wfe build"`
- **WHEN** the CI build step runs `pnpm build`
- **THEN** the `workflows` bundle build SHALL be invoked as part of the recursive workspace build
- **AND** a broken demo.ts SHALL cause the step to exit non-zero

### Requirement: pnpm store caching
The workflow SHALL cache the pnpm store across runs using `actions/setup-node` with pnpm caching enabled.

#### Scenario: Cache hit
- **WHEN** the pnpm lockfile has not changed since the last run
- **THEN** the pnpm store SHALL be restored from cache, reducing install time

#### Scenario: Cache miss
- **WHEN** the pnpm lockfile has changed
- **THEN** the pnpm store SHALL be populated from a fresh install and saved to cache

### Requirement: Node.js version
The workflow SHALL use Node.js 24.

#### Scenario: Node.js setup
- **WHEN** the workflow runs
- **THEN** Node.js 24 SHALL be installed via `actions/setup-node`

### Requirement: Staging deploy workflow

The system SHALL provide a GitHub Actions workflow at `.github/workflows/deploy-staging.yml` that runs on every push to the `main` branch. The workflow SHALL build the runtime image with `--build-arg GIT_SHA=${{ github.sha }}` and push it to `ghcr.io/stefanhoelzl/workflow-engine:main`. The workflow SHALL NOT invoke `tofu` in any step.

#### Scenario: Push to main triggers deploy

- **WHEN** a commit is pushed to `main`
- **THEN** the staging deploy workflow SHALL start

#### Scenario: Push to feature branch does not trigger deploy

- **WHEN** a commit is pushed to any branch other than `main` (including open PR branches)
- **THEN** the staging deploy workflow SHALL NOT start

#### Scenario: Workflow does not invoke tofu

- **WHEN** the workflow's steps are inspected
- **THEN** no step SHALL run `tofu` (init, plan, apply, output, or otherwise)

### Requirement: Staging build and push step

The staging deploy workflow SHALL reuse the existing composite action `.github/actions/docker-build` with `push: "true"`, `tags: ghcr.io/stefanhoelzl/workflow-engine:main`, and `build-args: GIT_SHA=${{ github.sha }}`. The Dockerfile SHALL bake `GIT_SHA` into the image as `ENV APP_GIT_SHA=${GIT_SHA}` so the running container's `/readyz` endpoint reflects the build SHA at runtime.

#### Scenario: Image pushed with main tag

- **WHEN** the build step completes successfully
- **THEN** the image SHALL exist at `ghcr.io/stefanhoelzl/workflow-engine:main` on ghcr.io
- **AND** the image SHALL embed `APP_GIT_SHA=<github.sha>` in its environment

#### Scenario: Build failure stops workflow

- **WHEN** the build or push step fails
- **THEN** subsequent steps SHALL NOT run

### Requirement: Staging deploy secrets

The GitHub repository SHALL define the following Actions secrets for the staging deploy workflow: `GH_UPLOAD_TOKEN` (for the demo upload step). No tofu-related secrets and no SSH key SHALL be referenced by `deploy-staging.yml`. The default `GITHUB_TOKEN` is sufficient for `docker push` to ghcr.io.

#### Scenario: No tofu secrets referenced

- **WHEN** `.github/workflows/deploy-staging.yml` is inspected
- **THEN** `TF_VAR_*`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SCW_*`, and `DEPLOY_SSH_PRIVATE_KEY` SHALL NOT appear

#### Scenario: Secrets do not appear in logs

- **WHEN** the workflow run is inspected
- **THEN** no secret value SHALL be visible in any step's stdout or stderr

### Requirement: Prod deploy workflow

The system SHALL provide a GitHub Actions workflow at `.github/workflows/deploy-prod.yml` that runs on every push to the `release` branch. The workflow SHALL declare `environment: production` so a required reviewer must approve before any step runs. After approval, the workflow SHALL build the runtime image with `--build-arg GIT_SHA=${{ github.sha }}`, push it to `ghcr.io/stefanhoelzl/workflow-engine:release`, capture the pushed image digest, and then roll the **prod** Bunny Magic Containers app forward to that digest (`image_tag: release` + `image_digest: <digest>`) via the SHA-pinned `BunnyWay/actions/container-update-image` action or an equivalent inline `curl` PATCH, resolving the app id by name. The workflow SHALL then poll the prod Bunny-served `/readyz` until `version.gitSha === ${{ github.sha }}`. The workflow SHALL NOT invoke `tofu` in any step. The workflow SHALL NOT upload any demo bundle (prod bundles come from external authors).

#### Scenario: Push to release triggers deploy

- **WHEN** a commit is pushed to `release`
- **THEN** the prod deploy workflow SHALL start

#### Scenario: Push to main does not trigger prod deploy

- **WHEN** a commit is pushed to `main` (or any branch other than `release`)
- **THEN** the prod deploy workflow SHALL NOT start

#### Scenario: Approval pauses build-and-push

- **WHEN** a commit is pushed to `release` and the workflow becomes eligible to start
- **THEN** execution SHALL pause until a required reviewer approves the run in the GitHub UI
- **AND** the build step SHALL NOT run before approval

#### Scenario: Deploy rolls the prod Bunny app and confirms the SHA

- **WHEN** the build-and-push step completes (after reviewer approval)
- **THEN** the workflow SHALL roll the prod Bunny app to the pushed image digest
- **AND** SHALL poll the prod `/readyz` until `version.gitSha === ${{ github.sha }}`

#### Scenario: Workflow does not invoke tofu

- **WHEN** the workflow's steps are inspected
- **THEN** no step SHALL run `tofu`

### Requirement: Prod build and push step

The prod deploy workflow SHALL reuse the existing composite action `.github/actions/docker-build` with `push: "true"`, `tags: ghcr.io/stefanhoelzl/workflow-engine:release`, and `build-args: GIT_SHA=${{ github.sha }}`.

#### Scenario: Image pushed with release tag

- **WHEN** the build step completes successfully (after reviewer approval)
- **THEN** the image SHALL exist at `ghcr.io/stefanhoelzl/workflow-engine:release` on ghcr.io
- **AND** the image SHALL embed `APP_GIT_SHA=<github.sha>` in its environment

#### Scenario: Build failure stops workflow

- **WHEN** the build or push step fails
- **THEN** the workflow SHALL fail (no further steps)

### Requirement: Prod deploy secrets

The GitHub repository SHALL define exactly the secrets required by the prod deploy workflow. After this change the prod deploy workflow needs no tofu secrets, no SSH key, no UpCloud token, no Dynu key, and no AWS state credentials. The default `GITHUB_TOKEN` is sufficient for `docker push`; the only additional secret is `BUNNYNET_API_KEY`, used to roll the prod Bunny app forward (the same account key already used by `deploy-staging.yml` and `plan-infra.yml`). The `production` GitHub Environment SHALL require at least one reviewer before any step runs.

#### Scenario: Only the Bunny key is added; no VPS infra secrets

- **WHEN** `.github/workflows/deploy-prod.yml` is inspected
- **THEN** `TF_VAR_*`, `AWS_*`, `UPCLOUD_*`, `SCW_*`, `DYNU_*`, and `DEPLOY_SSH_PRIVATE_KEY` SHALL NOT appear
- **AND** the only deploy secret beyond `GITHUB_TOKEN` SHALL be `BUNNYNET_API_KEY`

#### Scenario: Approval required before any step

- **WHEN** a reviewer has not approved the `production` environment gate
- **THEN** every step SHALL remain pending (subject to GitHub's default 30-day timeout)

### Requirement: Release branch protection

The `release` branch SHALL have branch protection configured to disallow force-pushes and deletion. Direct pushes (including cherry-picks) SHALL remain allowed.

#### Scenario: Force-push rejected

- **WHEN** any contributor attempts `git push --force origin release`
- **THEN** GitHub SHALL reject the push

#### Scenario: Deletion rejected

- **WHEN** any contributor attempts to delete the `release` branch
- **THEN** GitHub SHALL reject the deletion

#### Scenario: Cherry-pick push accepted

- **WHEN** a contributor runs `git cherry-pick <sha> && git push origin release` with a fast-forward or new-commit push
- **THEN** GitHub SHALL accept the push
- **AND** the prod deploy workflow SHALL trigger

### Requirement: Infra plan gate workflow trigger

The repository SHALL provide a GitHub Actions workflow at `.github/workflows/plan-infra.yml` that runs on every `pull_request` event targeting the `main` branch. The workflow SHALL run a single job that operates against the single `infrastructure/` project (no matrix). The workflow SHALL NOT trigger on any other event (no `push`, no `schedule`, no `workflow_dispatch`).

#### Scenario: PR opened against main

- **WHEN** a contributor opens a pull request whose base branch is `main`
- **THEN** the workflow triggers and produces one status check named `plan-infra`

#### Scenario: PR opened against release branch

- **WHEN** a contributor opens a pull request whose base branch is `release`
- **THEN** the workflow does NOT trigger

#### Scenario: Push to main

- **WHEN** a commit is pushed directly to `main`
- **THEN** the workflow does NOT trigger

### Requirement: Infra plan gate uses detailed exit codes

The single `plan-infra` job SHALL invoke `tofu plan -detailed-exitcode -lock=false -no-color` in `infrastructure/` after `tofu init`. The job SHALL pass when `tofu plan` returns exit code 0 (no diff). The job SHALL fail when `tofu plan` returns exit code 1 (error) or 2 (diff present). The infra is operator-applied (`changes-allowed: false`); a non-empty plan means the operator has not yet applied a base change.

The job SHALL pass the secret-bearing `TF_VAR_*` inputs (OAuth credentials, `bunnynet_api_key`, `state_passphrase`) from GHA secrets so every per-env Bunny `env` block's content-hash renders at plan time; because those inputs are declared `sensitive` and the token-mint/storage-zone attributes are sensitive, no secret value leaks into the plan. (There is no longer a host env-file dummy-secrets directory — the VPS `null_resource` env-file `filemd5(...)` triggers no longer exist.)

#### Scenario: Plan shows no diff

- **WHEN** `tofu plan -detailed-exitcode` returns exit code 0 against `infrastructure/`
- **THEN** the job succeeds and `plan-infra` reports success

#### Scenario: Plan shows a diff

- **WHEN** `tofu plan -detailed-exitcode` returns exit code 2 (the operator has not applied the change yet)
- **THEN** the job fails and `plan-infra` reports failure, blocking merge

#### Scenario: Plan errors out

- **WHEN** `tofu plan` returns exit code 1 (provider misconfig, expired token, backend unreachable)
- **THEN** the job fails

### Requirement: Infra plan output rendered into step summary

The single `plan-infra` job SHALL pipe the full `tofu plan` output into `$GITHUB_STEP_SUMMARY` wrapped in an `hcl` fenced code block, regardless of exit code. The workflow SHALL NOT post PR comments, upload plan artifacts, or send notifications to external channels.

#### Scenario: Reviewer inspects a failed plan check

- **WHEN** a reviewer opens the failed GitHub Actions run for the `plan-infra` check
- **THEN** the run's Summary tab displays the full plan diff as rendered markdown without requiring the reviewer to re-run `tofu plan` locally

#### Scenario: Passing plan still renders summary

- **WHEN** the plan is empty and the check passes
- **THEN** the Summary still contains the (empty) plan output so reviewers can confirm by inspection

### Requirement: Main branch ruleset requires both plan checks

The repository's `main` branch ruleset SHALL list `plan-infra` in its `required_status_checks` rule, with `strict_required_status_checks_policy: true`. The ruleset SHALL declare `bypass_actors: []` — no per-PR bypass path exists for any user or role. The escape hatch for a broken gate is to temporarily flip the ruleset's `enforcement` field to `disabled` via `gh api PUT`, merge the fix, and flip it back to `active`.

#### Scenario: PR with failing plan check cannot merge

- **WHEN** a PR targets `main` and `plan-infra` reports failure
- **THEN** GitHub prevents the merge, regardless of the actor (including repository administrators)

#### Scenario: No per-PR bypass

- **WHEN** any actor attempts to merge a PR whose required check has not passed
- **THEN** the merge is blocked

#### Scenario: Emergency ruleset disable

- **WHEN** the plan workflow itself is broken (regression in workflow file) and a fix PR needs to merge
- **THEN** a repository administrator MAY `gh api --method PUT repos/:owner/:repo/rulesets/<id>` with `enforcement: "disabled"`, merge the fix, and `PUT` again with `enforcement: "active"`; no per-PR merge-button bypass is used

### Requirement: Staging demo workflow upload step

The staging deploy workflow SHALL, after the readiness gate succeeds (see "Staging readiness gate before upload"), upload the monorepo's `workflows/` bundle to the staging runtime at `https://staging.workflow-engine.stho.net`. The upload SHALL authenticate as `github:user:stefanhoelzl` using a fine-grained Personal Access Token stored in the repository secret `GH_UPLOAD_TOKEN`, which SHALL be passed to the upload step as the `GITHUB_TOKEN` environment variable. The CLI SHALL auto-detect the target `(owner, repo)` scope from `git remote get-url origin` (yielding `stefanhoelzl/workflow-engine`).

Upload failure SHALL fail the deploy job. The step SHALL NOT use `continue-on-error`.

#### Scenario: Successful deploy uploads demo bundle

- **GIVEN** the readiness gate confirms the new image is running on staging
- **WHEN** the upload step runs
- **THEN** `wfe upload --url https://staging.workflow-engine.stho.net` SHALL be invoked against `stefanhoelzl/workflow-engine`
- **AND** the `GITHUB_TOKEN` env SHALL be the `GH_UPLOAD_TOKEN` secret value
- **AND** the staging runtime SHALL respond `204 No Content`
- **AND** the deploy job SHALL succeed

#### Scenario: Upload failure fails the deploy

- **GIVEN** the upload step returns non-zero (e.g., 401 Unauthorized, bundle rejected, network error)
- **WHEN** the job evaluates step results
- **THEN** the job SHALL be marked failed
- **AND** no step SHALL use `continue-on-error: true` to mask the failure

#### Scenario: Prod deploy does not upload demo

- **WHEN** the `deploy-prod` workflow runs
- **THEN** it SHALL NOT upload the `workflows/` bundle

### Requirement: Staging readiness gate before upload

Before invoking the upload step, the staging deploy workflow SHALL poll `https://staging.workflow-engine.stho.net/readyz` until both of the following hold:

1. The response status is `200`.
2. The response JSON's `version.gitSha` field equals `${{ github.sha }}` — i.e. the new image (not a previously-running one) is the one serving requests.

The poll SHALL retry on a fixed interval (e.g. every 5 seconds) for an upper bound of approximately 5 minutes. If either condition is not met within the budget, the step SHALL fail and the upload step SHALL NOT run.

The workflow SHALL NOT invoke `kubectl`, `upctl`, or any K8s-shaped readiness primitive. The deploy mechanism is `podman-auto-update.timer` (see `infrastructure` capability) which polls the registry every 1 minute; the readiness gate exists to bridge the asynchronous gap between `docker push` and the new container actually running.

#### Scenario: Probe succeeds after auto-update tick

- **GIVEN** the auto-update timer pulls the new image and restarts the unit within the retry budget
- **WHEN** the readiness step polls `/readyz`
- **THEN** the step SHALL observe `200` with `version.gitSha === <github.sha>`
- **AND** SHALL exit `0`
- **AND** the upload step SHALL proceed

#### Scenario: Probe times out fails the deploy

- **GIVEN** the auto-update tick does not happen within the retry budget (e.g. registry rate-limit, image pull failure)
- **WHEN** the readiness step exhausts its retries
- **THEN** the step SHALL exit non-zero
- **AND** the upload step SHALL NOT run
- **AND** the deploy job SHALL fail

#### Scenario: Probe sees old gitSha and continues polling

- **GIVEN** `/readyz` returns `200` with `version.gitSha === <previous-deploy-sha>` (the auto-update tick has not happened yet)
- **WHEN** the readiness step evaluates the response
- **THEN** the step SHALL NOT exit
- **AND** SHALL continue polling until either `gitSha === <github.sha>` or the budget is exhausted

### Requirement: Staging demo upload auth secret

The repository SHALL define a secret named `GH_UPLOAD_TOKEN` holding a fine-grained GitHub Personal Access Token whose authenticated identity (`GET /user.login`) is `stefanhoelzl`. The token SHALL NOT require any GitHub-side scopes beyond what `GET /user` permits by default. The secret SHALL be referenced only by `deploy-staging.yml` and SHALL NOT be referenced by `deploy-prod.yml` or any PR-triggered workflow.

`AUTH_ALLOW_STAGING` (the GitHub Actions variable passed as `TF_VAR_auth_allow`) SHALL continue to include `github:user:stefanhoelzl` so that the token's identity is permitted by the staging runtime's ACL.

#### Scenario: Secret referenced by staging deploy only

- **WHEN** inspecting `.github/workflows/*.yml`
- **THEN** exactly one workflow (`deploy-staging.yml`) SHALL reference `secrets.GH_UPLOAD_TOKEN`

#### Scenario: Token identity is permitted by staging ACL

- **GIVEN** the upload step authenticates with `GH_UPLOAD_TOKEN`
- **WHEN** the staging runtime resolves the user via its github auth provider
- **THEN** the user's `login` SHALL be `stefanhoelzl`
- **AND** `isMember(user, owner="stefanhoelzl")` SHALL return true

### Requirement: deploy-image composite action

The repository SHALL provide a composite GitHub Action at `.github/actions/deploy-image/` that encapsulates the full bunny.net rolling deploy: ghcr login → build + push the runtime image (via the existing `docker-build` composite action) → resolve the named Magic Containers app id by name → roll that app forward to the pushed digest via the SHA-pinned `BunnyWay/actions/container-update-image` action → poll the target URL's `/readyz` until `version.gitSha === ${{ github.sha }}`. `deploy-prod.yml` SHALL consume it via `uses: ./.github/actions/deploy-image`. Inputs: `tag` (e.g. `release`), `url` (target URL whose `/readyz` reports the running gitSha), `app_name` (the Magic Containers app to roll, e.g. `wfe-prod`), `github_token` (ghcr auth), and `bunnynet_api_key` (app-id resolution + the rolling update). The `BunnyWay/actions/container-update-image` action MUST be pinned to a commit SHA because it receives `bunnynet_api_key`.

#### Scenario: Prod deploy uses the shared action

- **WHEN** `.github/workflows/deploy-prod.yml` is inspected
- **THEN** it contains exactly one `uses: ./.github/actions/deploy-image` step
- **AND** that step is the only place the build / push / Bunny-roll / readyz-poll logic lives for prod
- **AND** it passes `app_name: wfe-prod` and `bunnynet_api_key`

#### Scenario: Rolling-update action is SHA-pinned

- **WHEN** the `deploy-image` action is inspected
- **THEN** `BunnyWay/actions/container-update-image` SHALL be referenced by a commit SHA, not a moving ref

### Requirement: PR publish-shape smoke test

The PR validation workflow SHALL include a job that exercises the SDK + core publish artifacts against `workflows/src/demo.ts`. The job SHALL run on every PR (no path filter).

The job SHALL:

1. Install workspace dependencies and run `pnpm -r build`.
2. Run `pnpm pack` in `packages/core` and `packages/sdk` to produce `.tgz` tarballs identical in shape to what `pnpm publish` would upload (including the `workspace:*` → concrete-version rewrite).
3. Create a temporary project directory outside the workspace and run `npm init -y`.
4. Install both tarballs together via `npm install <core-tarball> <sdk-tarball>`, so the SDK's `@workflow-engine/core` dependency resolves to the local tarball rather than the npm registry.
5. Copy `workflows/src/demo.ts` into the temporary project's `src/` directory.
6. Run `npx wfe build` from the temporary project.
7. Assert that `dist/demo.js` exists and is non-empty.

After the consumer-side build assertion, the job SHALL additionally invoke `npm publish --dry-run --access public --provenance` against each packed tarball. The dry-run SHALL NOT authenticate to or contact the npm registry; its purpose is to validate the publish-shape from npm's client-side perspective (package.json metadata, files-array completeness, presence of `repository` for provenance, scoped-package access settings, `bin` path resolution against the tarball, SPDX license validity). Either dry-run failing SHALL fail the PR.

The job SHALL fail the PR if any step fails. The job's purpose is to detect failure modes that the workspace's symlinked `workspace:*` resolution hides — `exports` map errors, missing `dist/` files, leaked `workspace:*` deps, missing executable bits on `wfe`, undeclared peer dependencies, `.d.ts` references to workspace-internal paths, and publish-shape errors that would surface only at the release-time publish.

#### Scenario: Smoke test passes for canonical demo

- **GIVEN** a PR whose changes preserve the SDK's published shape
- **WHEN** the smoke-test job runs
- **THEN** all steps SHALL succeed
- **AND** `dist/demo.js` SHALL exist in the temporary project after `npx wfe build`

#### Scenario: Broken `exports` map fails the smoke test

- **GIVEN** a PR that introduces a typo in `packages/sdk/package.json` `exports` (e.g. points at `./dis/index.js`)
- **WHEN** the smoke-test job's `npm install` and `npx wfe build` steps run
- **THEN** module resolution from the temporary project SHALL fail
- **AND** the job SHALL exit non-zero

#### Scenario: Leaked workspace dep fails the smoke test

- **GIVEN** a PR that adds a `workspace:*` dep to `packages/sdk/package.json` for a package that is not in the publish set
- **WHEN** the smoke-test job's `npm install` step runs
- **THEN** npm SHALL fail to resolve the dep
- **AND** the job SHALL exit non-zero

#### Scenario: Smoke test runs on unrelated PRs

- **GIVEN** a PR whose changes do not touch `packages/sdk`, `packages/core`, or `workflows/`
- **WHEN** the PR validation workflow runs
- **THEN** the smoke-test job SHALL still execute (no path filter)

#### Scenario: Publish dry-run rejects missing repository field

- **GIVEN** a PR whose changes remove the `repository` field from `packages/core/package.json`
- **WHEN** the smoke-test job's `npm publish --dry-run --provenance` step runs against the core tarball
- **THEN** the dry-run SHALL exit non-zero
- **AND** the job SHALL fail the PR

#### Scenario: Publish dry-run rejects malformed package metadata

- **GIVEN** a PR that introduces an invalid SPDX license identifier or a `files` entry referencing a non-existent path
- **WHEN** the smoke-test job's `npm publish --dry-run` step runs
- **THEN** the dry-run SHALL exit non-zero with a message naming the offending field
- **AND** the job SHALL fail the PR

#### Scenario: Publish dry-run does not authenticate

- **WHEN** the smoke-test job's `npm publish --dry-run` step runs
- **THEN** the step SHALL NOT contact the npm registry for authentication
- **AND** SHALL succeed without `NODE_AUTH_TOKEN` or any OIDC token exchange
- **AND** SHALL run identically on PRs from forks (which have no access to repo secrets or the production environment)

### Requirement: Release publish job to npm

The prod deploy workflow (push to the `release` branch) SHALL include a job that publishes `@workflow-engine/core` and `@workflow-engine/sdk` to npm in lockstep when their source has changed since the last published tag. The job SHALL run on the same workflow event as the prod image push, under `environment: production`, and SHALL NOT block or be blocked by the image push.

The job SHALL execute the following steps in order:

1. Checkout (with `fetch-depth: 0` so `git describe` sees tags), setup-node ≥ 22.14, setup-pnpm, `pnpm install --frozen-lockfile`, `pnpm -r build`.
2. Locate the most recent annotated/lightweight tag matching `v*` via `git describe --tags --match 'v*' --abbrev=0`. If none exists, treat it as the empty range (publish unconditionally).
3. Run `git diff --name-only $LAST_TAG..HEAD -- packages/sdk packages/core`.
4. **If the diff is empty**, the job SHALL exit successfully without publishing or tagging.
5. **If the diff is non-empty**, the job SHALL compute the next CalVer version by querying `npm view @workflow-engine/sdk version` and applying the rule: `if latest is YYYY.M.PATCH and matches the current UTC year+month, increment PATCH; otherwise reset to YYYY.M.0`.
6. Rewrite the `version` field in `packages/core/package.json` and `packages/sdk/package.json` to the computed value (in-place, not committed back to the branch).
7. Run `pnpm --filter @workflow-engine/core pack` and `pnpm --filter @workflow-engine/sdk pack` to produce tarballs with `workspace:*` rewritten to the computed concrete version.
8. Run `npm publish <core-tarball> --access public --provenance`, then `npm publish <sdk-tarball> --access public --provenance`. The order matters: sdk's tarball references core@$VERSION, so core MUST be on the registry before sdk is published.
9. Tag the current commit `v$VERSION` and push the tag to origin.

The job SHALL authenticate to npm using **trusted publishing (OIDC)** — no `NODE_AUTH_TOKEN`, no static credential. Each package's trusted-publisher binding on npmjs.com SHALL pin to the repository `stefanhoelzl/workflow-engine`, the workflow file `.github/workflows/deploy-prod.yml`, the `release` branch, and the `production` GitHub Actions environment. The job SHALL declare `permissions: id-token: write` (for OIDC + provenance) and `permissions: contents: write` (for the tag push).

The publish step SHALL use `npm publish <tarball>` rather than `pnpm publish`, because `pnpm publish` does not reliably perform the OIDC token exchange against npm 11.5.1+ on GitHub-hosted runners (pnpm/pnpm#9812). `pnpm pack` is used for tarball generation; `npm publish` is used for the actual publish.

#### Scenario: First publish creates initial version

- **GIVEN** the repository has no `v*` git tag yet
- **AND** push to `release` includes changes under `packages/sdk` or `packages/core`
- **WHEN** the publish job runs
- **THEN** it SHALL compute the version as `<UTC-YEAR>.<UTC-MONTH>.0`
- **AND** publish both packages with that version
- **AND** push the tag `v<UTC-YEAR>.<UTC-MONTH>.0`

#### Scenario: Subsequent publish in the same calendar month bumps patch

- **GIVEN** the latest published version is `2026.5.0`
- **AND** the most recent `v*` tag is `v2026.5.0`
- **AND** the current UTC date is in May 2026
- **AND** push to `release` includes changes under `packages/sdk` or `packages/core` since `v2026.5.0`
- **WHEN** the publish job runs
- **THEN** it SHALL publish version `2026.5.1`
- **AND** push the tag `v2026.5.1`

#### Scenario: First publish in a new calendar month resets patch

- **GIVEN** the latest published version is `2026.5.3`
- **AND** the current UTC date is in June 2026
- **AND** push to `release` includes changes under `packages/sdk` or `packages/core` since `v2026.5.3`
- **WHEN** the publish job runs
- **THEN** it SHALL publish version `2026.6.0`
- **AND** push the tag `v2026.6.0`

#### Scenario: Push to release with no SDK or core changes does not publish

- **GIVEN** the most recent `v*` tag is `v2026.5.1`
- **AND** push to `release` contains only changes under `packages/runtime`, `infrastructure/`, or other non-publishable paths
- **WHEN** the publish job runs
- **THEN** the job SHALL exit successfully
- **AND** SHALL NOT publish to npm
- **AND** SHALL NOT push a new tag

#### Scenario: Publish authentication via trusted publishing

- **WHEN** the publish job invokes `npm publish` against either tarball
- **THEN** authentication SHALL use npm trusted publishing — the GitHub Actions OIDC token, exchanged with npm at publish time
- **AND** the job SHALL NOT use `NODE_AUTH_TOKEN` or any other long-lived credential
- **AND** the workflow's `permissions` block SHALL include `id-token: write` and `contents: write`
- **AND** the job SHALL run under `environment: production`
- **AND** the published tarballs SHALL carry sigstore provenance attestations linking them to the GitHub Actions run and commit SHA

#### Scenario: Publish step uses npm publish on packed tarballs

- **WHEN** the publish job reaches the publish step
- **THEN** it SHALL invoke `npm publish <tarball> --access public --provenance` once per package, in the order core then sdk
- **AND** SHALL NOT invoke `pnpm publish` or `pnpm -r publish`
- **AND** the tarballs SHALL have been produced by `pnpm pack` (which performs the `workspace:*` → concrete-version rewrite)

#### Scenario: Trusted publisher binding rejects publish from a different workflow

- **GIVEN** a malicious or accidental new workflow file at `.github/workflows/other.yml` that attempts `npm publish` against either package
- **WHEN** that workflow runs (even on the `release` branch with `id-token: write`)
- **THEN** npm's trusted-publisher check SHALL reject the publish because the workflow path does not match the binding
- **AND** the publish SHALL fail with a clear error

#### Scenario: Lockstep versioning of sdk and core

- **WHEN** the publish job publishes any version `$VERSION`
- **THEN** both `@workflow-engine/core@$VERSION` and `@workflow-engine/sdk@$VERSION` SHALL be published in the same job run
- **AND** the SDK's published tarball SHALL declare its `@workflow-engine/core` dependency as `$VERSION` (not `workspace:*`)

