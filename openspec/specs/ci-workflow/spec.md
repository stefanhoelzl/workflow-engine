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

The system SHALL provide a GitHub Actions workflow at `.github/workflows/deploy-staging.yml` that runs on every push to the `main` branch. The workflow SHALL build the runtime image, push it to `ghcr.io/stefanhoelzl/workflow-engine:main`, capture the resulting image digest from the `docker/build-push-action` output, and run `tofu apply` on `infrastructure/envs/staging/` with `-var image_digest=<captured-digest>`.

#### Scenario: Push to main triggers deploy

- **WHEN** a commit is pushed to `main`
- **THEN** the staging deploy workflow SHALL start

#### Scenario: Push to feature branch does not trigger deploy

- **WHEN** a commit is pushed to any branch other than `main` (including open PR branches)
- **THEN** the staging deploy workflow SHALL NOT start

### Requirement: Staging build and push step

The staging deploy workflow SHALL reuse the existing composite action `.github/actions/docker-build` with `push: "true"` and `tags: ghcr.io/stefanhoelzl/workflow-engine:main`. The resulting image digest SHALL be captured as a step output (`steps.<build>.outputs.digest`) from `docker/build-push-action@v7`.

#### Scenario: Image pushed with main tag

- **WHEN** the build step completes successfully
- **THEN** the image SHALL exist at `ghcr.io/stefanhoelzl/workflow-engine:main` on ghcr.io
- **AND** the step SHALL expose the image digest as an output

#### Scenario: Build failure stops workflow

- **WHEN** the build or push step fails
- **THEN** subsequent steps (including `tofu apply`) SHALL NOT run

### Requirement: Staging tofu apply step

The staging deploy workflow SHALL run `tofu init && tofu apply -auto-approve -var image_digest=${{ steps.<build>.outputs.digest }}` in the `infrastructure/envs/staging/` directory. The step SHALL have access to these secrets via environment variables: `TF_VAR_state_passphrase`, `TF_VAR_upcloud_token`, `TF_VAR_dynu_api_key`, `TF_VAR_oauth2_client_id`, `TF_VAR_oauth2_client_secret`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

#### Scenario: Successful apply rolls out digest-pinned image

- **WHEN** the `tofu apply` step runs with a captured digest
- **THEN** the staging Deployment's container image SHALL be `ghcr.io/stefanhoelzl/workflow-engine@<captured-digest>`
- **AND** Kubernetes SHALL perform a rolling update if the digest differs from the previous apply

#### Scenario: Apply with unchanged digest is a no-op

- **WHEN** `tofu apply` runs with a digest identical to the currently-deployed one (e.g. re-running the workflow without a new commit)
- **THEN** no Deployment rollout SHALL be triggered

### Requirement: Staging deploy serialization

The staging deploy workflow SHALL declare `concurrency: { group: tofu-staging, cancel-in-progress: false }`. Parallel runs triggered by rapid successive pushes SHALL queue, not cancel each other.

#### Scenario: Two pushes in rapid succession

- **WHEN** two commits land on `main` 10 seconds apart
- **THEN** two workflow runs SHALL be scheduled
- **AND** the second run SHALL wait for the first to finish before its `tofu apply` step executes
- **AND** neither run SHALL be cancelled

### Requirement: Staging deploy secrets

The GitHub repository SHALL define the following Actions secrets for the staging deploy workflow: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN` (scoped to K8s-read and Object Storage), `TF_VAR_DYNU_API_KEY`, `TF_VAR_OAUTH2_CLIENT_ID`, `TF_VAR_OAUTH2_CLIENT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Secrets SHALL be consumed by the workflow via `env` blocks and SHALL NOT be printed to logs.

#### Scenario: Secret missing blocks apply

- **WHEN** the workflow runs without `TF_VAR_UPCLOUD_TOKEN` configured
- **THEN** `tofu apply` SHALL fail at the ephemeral block with a missing-credentials error

#### Scenario: Secrets do not appear in logs

- **WHEN** the workflow run is inspected
- **THEN** no secret value SHALL be visible in any step's stdout or stderr

### Requirement: First staging deploy bootstrap

The first `tofu apply` for `envs/staging/` SHALL be run by an operator (not via the workflow) with a bootstrap `image_digest` value obtained by running the staging deploy workflow once via `workflow_dispatch`. Subsequent deploys SHALL run automatically on push to `main`.

#### Scenario: Bootstrap via workflow_dispatch

- **WHEN** an operator triggers the staging deploy workflow manually via `workflow_dispatch` before the staging project has state
- **THEN** the build + push + digest-capture steps SHALL succeed
- **AND** the `tofu apply` step MAY fail due to missing state (acceptable on bootstrap)
- **AND** the operator SHALL capture the digest from the step output and run `tofu apply` locally to create the initial state

#### Scenario: Subsequent deploys are automatic

- **WHEN** the staging project has state after the bootstrap
- **THEN** every push to `main` SHALL trigger a successful end-to-end deploy without operator intervention

### Requirement: Prod deploy workflow

The system SHALL provide a GitHub Actions workflow at `.github/workflows/deploy-prod.yml` that runs on every push to the `release` branch. The workflow SHALL be composed of two jobs: (1) a `plan` job (unattended) that builds the runtime image, pushes it to `ghcr.io/stefanhoelzl/workflow-engine:release`, captures the resulting image digest, and renders a `tofu plan` into the GitHub Actions job summary; (2) an `apply` job that declares `environment: production`, depends on `plan` via `needs`, and — after a required-reviewer approval inside that environment — runs `tofu apply` on `infrastructure/envs/prod/` with `-var image_digest=<captured-digest>`. After apply, the workflow SHALL fetch a kubeconfig for the prod cluster and block on `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m`.

#### Scenario: Push to release triggers deploy

- **WHEN** a commit is pushed to `release`
- **THEN** the prod deploy workflow SHALL start

#### Scenario: Push to main does not trigger prod deploy

- **WHEN** a commit is pushed to `main` (or any branch other than `release`)
- **THEN** the prod deploy workflow SHALL NOT start

#### Scenario: Approval pauses apply

- **WHEN** the `plan` job finishes and the `apply` job (which declares `environment: production`) becomes eligible to start
- **THEN** execution SHALL pause until a required reviewer approves the run in the GitHub UI
- **AND** `tofu apply` SHALL NOT run before approval

#### Scenario: Plan renders before approval

- **WHEN** the `plan` job completes successfully before the reviewer decides
- **THEN** the `tofu plan` text SHALL be visible in the run's Summary tab
- **AND** the reviewer MAY read it before clicking approve

### Requirement: Prod build and push step

The prod deploy workflow SHALL reuse the existing composite action `.github/actions/docker-build` with `push: "true"` and `tags: ghcr.io/stefanhoelzl/workflow-engine:release`. The resulting image digest SHALL be captured as a step output from `docker/build-push-action@v7`.

#### Scenario: Image pushed with release tag

- **WHEN** the build step completes successfully
- **THEN** the image SHALL exist at `ghcr.io/stefanhoelzl/workflow-engine:release` on ghcr.io
- **AND** the step SHALL expose the image digest as an output

#### Scenario: Build failure stops workflow

- **WHEN** the build or push step fails
- **THEN** the plan, approval, and apply steps SHALL NOT run

### Requirement: Prod tofu plan rendered to job summary

The prod deploy workflow SHALL run `tofu init && tofu plan -no-color -var image_digest=<captured-digest>` in `infrastructure/envs/prod/` and append the plan output to the job summary (`$GITHUB_STEP_SUMMARY`).

#### Scenario: Plan succeeds

- **WHEN** `tofu plan` exits 0
- **THEN** the plan text SHALL appear in the run's Summary tab
- **AND** the workflow SHALL proceed to the approval-gated apply step

#### Scenario: Plan fails

- **WHEN** `tofu plan` exits non-zero
- **THEN** the step SHALL fail
- **AND** the apply step SHALL NOT run

### Requirement: Prod tofu apply step

The prod deploy workflow SHALL run `tofu apply -auto-approve -var image_digest=<captured-digest>` in `infrastructure/envs/prod/` inside the `apply` job, which declares `environment: production`. The step SHALL have access to these secrets via environment variables: `TF_VAR_state_passphrase`, `TF_VAR_upcloud_token`, `TF_VAR_dynu_api_key`, `TF_VAR_github_oauth_client_id` (from `GH_APP_CLIENT_ID_PROD`), `TF_VAR_github_oauth_client_secret` (from `GH_APP_CLIENT_SECRET_PROD`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

#### Scenario: Successful apply rolls out digest-pinned image

- **WHEN** the `tofu apply` step runs with a captured digest after reviewer approval
- **THEN** the prod Deployment's container image SHALL be `ghcr.io/stefanhoelzl/workflow-engine@<captured-digest>`
- **AND** Kubernetes SHALL perform a rolling update if the digest differs from the previous apply

#### Scenario: Apply with unchanged digest is a no-op

- **WHEN** `tofu apply` runs with a digest identical to the currently-deployed one
- **THEN** no Deployment rollout SHALL be triggered

### Requirement: Prod post-apply certificate readiness check

After `tofu apply` succeeds, the prod deploy workflow SHALL install `upctl` via `UpCloudLtd/upcloud-cli-action` at a pinned version, fetch a kubeconfig for the prod cluster using the existing `TF_VAR_UPCLOUD_TOKEN` credential, and run `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m`. A timeout or failure SHALL fail the workflow.

#### Scenario: Certificate already ready

- **WHEN** the Certificate resource is already `Ready=True` (normal case for most deploys)
- **THEN** `kubectl wait` SHALL return immediately
- **AND** the workflow SHALL succeed

#### Scenario: Certificate pending issuance

- **WHEN** the Certificate is issuing (e.g. a fresh apply rotating the cert)
- **THEN** `kubectl wait` SHALL block up to 5 minutes
- **AND** the workflow SHALL succeed once issuance completes

#### Scenario: Certificate fails to issue

- **WHEN** issuance does not complete within 5 minutes (DNS, CAA, port-80 misconfig)
- **THEN** `kubectl wait` SHALL exit non-zero
- **AND** the workflow SHALL fail

### Requirement: Prod deploy serialization

The prod deploy workflow SHALL declare `concurrency: { group: tofu-prod, cancel-in-progress: false }`. The group SHALL be distinct from the staging workflow's `tofu-staging` so prod and staging deploys run in parallel. Successive pushes to `release` SHALL queue and run in order; no run SHALL be cancelled.

#### Scenario: Prod and staging deploy concurrently

- **WHEN** a commit lands on `main` and a commit lands on `release` at the same time
- **THEN** both workflows SHALL run in parallel without blocking each other

#### Scenario: Two prod pushes in rapid succession

- **WHEN** two commits land on `release` 10 seconds apart
- **THEN** two workflow runs SHALL be scheduled
- **AND** the second run SHALL wait for the first to finish its apply before starting its own apply
- **AND** neither run SHALL be cancelled

### Requirement: Prod deploy secrets

The GitHub repository SHALL define, as repo-level Actions secrets, every credential the prod deploy workflow consumes: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_SECRET_PROD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Secrets SHALL be consumed via `env` blocks and SHALL NOT be printed to logs. The `production` GitHub Environment SHALL require at least one reviewer before the apply step runs.

#### Scenario: Missing prod OAuth secret blocks apply

- **WHEN** the workflow runs without `GH_APP_CLIENT_ID_PROD` or `GH_APP_CLIENT_SECRET_PROD` configured
- **THEN** `tofu apply` SHALL fail at the OAuth secret variable with a missing-value error

#### Scenario: Secrets do not appear in logs

- **WHEN** the workflow run is inspected
- **THEN** no secret value SHALL be visible in any step's stdout, stderr, or job summary

#### Scenario: Approval required for apply

- **WHEN** a reviewer has not approved the `production` environment gate
- **THEN** the apply step SHALL remain pending indefinitely (subject to GitHub's default 30-day timeout)

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

### Requirement: First prod deploy migration bootstrap

The first `tofu apply` on `envs/prod/` after this change lands SHALL be performed by the prod deploy workflow itself. No operator-side local `tofu apply` is required for the migration. The first apply SHALL change the container image reference from `ghcr.io/stefanhoelzl/workflow-engine:<tag>` (current state) to `ghcr.io/stefanhoelzl/workflow-engine@<digest>` (new state), triggering a single pod rollout.

#### Scenario: Migration apply runs via workflow

- **WHEN** the `release` branch is fast-forwarded to the merged `main` containing the deleted `image_tag` variable and added `image_digest` variable
- **THEN** the prod deploy workflow SHALL plan a Deployment update changing the image string to digest form
- **AND** after reviewer approval, the apply SHALL succeed
- **AND** the prod pod SHALL roll once

### Requirement: Infra plan gate workflow trigger

The repository SHALL provide a GitHub Actions workflow at `.github/workflows/plan-infra.yml` that runs on every `pull_request` event targeting the `main` branch. The workflow SHALL NOT trigger on any other event (no `push`, no `schedule`, no `workflow_dispatch`). The workflow SHALL run a matrix over `project: [cluster, persistence]`, producing two independent jobs that share no state.

#### Scenario: PR opened against main
- **WHEN** a contributor opens a pull request whose base branch is `main`
- **THEN** the workflow triggers and produces two status checks named `plan (cluster)` and `plan (persistence)`

#### Scenario: PR opened against release branch
- **WHEN** a contributor opens a pull request whose base branch is `release`
- **THEN** the workflow does NOT trigger

#### Scenario: Push to main
- **WHEN** a commit is pushed directly to `main`
- **THEN** the workflow does NOT trigger (the gate's purpose is to block the merge itself; post-merge runs are out of scope)

### Requirement: Infra plan gate uses detailed exit codes

Each matrix leg SHALL invoke `tofu plan -detailed-exitcode -lock=false -no-color` in the corresponding `infrastructure/envs/<project>/` working directory after `tofu init`. The job SHALL pass when `tofu plan` returns exit code 0 (no diff), and fail when it returns exit code 1 (error) or 2 (diff present). The `-lock=false` flag is REQUIRED so that concurrent PR plan runs do not serialize on the state-backend lockfile and do not contend with an operator running `tofu apply` locally.

#### Scenario: Plan shows no diff
- **WHEN** `tofu plan -detailed-exitcode` returns exit code 0 against the project
- **THEN** the matrix leg succeeds and its status check reports success

#### Scenario: Plan shows a diff
- **WHEN** `tofu plan -detailed-exitcode` returns exit code 2 against the project
- **THEN** the matrix leg fails and its status check reports failure, blocking merge (when the ruleset is active)

#### Scenario: Plan errors out
- **WHEN** `tofu plan` returns exit code 1 (e.g., provider misconfiguration, expired token, backend unreachable)
- **THEN** the matrix leg fails; the job log surfaces the provider/backend error

### Requirement: Infra plan output rendered into step summary

Each matrix leg SHALL pipe the full `tofu plan` output into `$GITHUB_STEP_SUMMARY` wrapped in an `hcl` fenced code block, regardless of exit code. The workflow SHALL NOT post PR comments, upload plan artifacts, or send notifications to external channels.

#### Scenario: Reviewer inspects a failed plan check
- **WHEN** a reviewer opens the failed GitHub Actions run for the `plan (cluster)` or `plan (persistence)` check
- **THEN** the run's Summary tab displays the full plan diff as rendered markdown without requiring the reviewer to re-run `tofu plan` locally

#### Scenario: Passing plan still renders summary
- **WHEN** the plan is empty and the check passes
- **THEN** the Summary still contains the (empty) plan output so reviewers can confirm by inspection

### Requirement: Infra plan gate secret wiring

The workflow SHALL consume the following existing repository secrets only: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`. No new secret SHALL be introduced. The matrix leg for `persistence` SHALL additionally export `UPCLOUD_TOKEN` (same value as `TF_VAR_UPCLOUD_TOKEN`), because `infrastructure/envs/persistence/persistence.tf` declares no UpCloud provider token variable and its module's provider resolves its credential from the `UPCLOUD_TOKEN` environment variable.

#### Scenario: Cluster matrix leg env
- **WHEN** the `cluster` matrix leg runs
- **THEN** it has `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_state_passphrase`, and `TF_VAR_upcloud_token` set in its environment

#### Scenario: Persistence matrix leg env
- **WHEN** the `persistence` matrix leg runs
- **THEN** it additionally has `UPCLOUD_TOKEN` set to the same value as `TF_VAR_UPCLOUD_TOKEN`, so the UpCloud provider inside the object-storage module can authenticate

### Requirement: Main branch ruleset requires both plan checks

The repository's `main` branch ruleset SHALL list `plan (cluster)` and `plan (persistence)` in its `required_status_checks` rule, with `strict_required_status_checks_policy: true`. The ruleset SHALL declare `bypass_actors: []` — no per-PR bypass path exists for any user or role. The escape hatch for a broken gate is to temporarily flip the ruleset's `enforcement` field to `disabled` via `gh api PUT`, merge the fix, and flip it back to `active`; this is an out-of-band operation, not a per-PR merge option.

#### Scenario: PR with failing plan check cannot merge
- **WHEN** a PR targets `main` and either `plan (cluster)` or `plan (persistence)` reports failure
- **THEN** GitHub prevents the merge, regardless of the actor (including repository administrators)

#### Scenario: No per-PR bypass
- **WHEN** any actor attempts to merge a PR whose required checks have not all passed
- **THEN** the merge is blocked; the ruleset's `current_user_can_bypass` is `"never"` for every role

#### Scenario: Emergency ruleset disable
- **WHEN** the plan workflow itself is broken (regression in workflow file) and a fix PR needs to merge
- **THEN** a repository administrator MAY `gh api --method PUT repos/:owner/:repo/rulesets/<id>` with `enforcement: "disabled"`, merge the fix, and `PUT` again with `enforcement: "active"`; no per-PR merge-button bypass is used

### Requirement: Staging demo workflow upload step

The staging deploy workflow SHALL, after `tofu apply` succeeds, upload the monorepo's `workflows/` bundle to the freshly-deployed staging runtime. The upload SHALL target the URL produced by `tofu output -raw url` from `infrastructure/envs/staging/`. The upload SHALL authenticate as `github:user:stefanhoelzl` using a fine-grained Personal Access Token stored in the repository secret `GH_UPLOAD_TOKEN`, which SHALL be passed to the upload step as the `GITHUB_TOKEN` environment variable. The CLI SHALL auto-detect the target `(owner, repo)` scope from `git remote get-url origin` (yielding `stefanhoelzl/workflow-engine`).

Upload failure SHALL fail the deploy job. The step SHALL NOT use `continue-on-error`.

#### Scenario: Successful deploy uploads demo bundle

- **GIVEN** `tofu apply` has just completed for staging and the runtime is ready
- **WHEN** the upload step runs
- **THEN** `wfe upload --url <staging-url>` SHALL be invoked against `stefanhoelzl/workflow-engine`
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
- **AND** `GH_UPLOAD_TOKEN` SHALL NOT be referenced by `deploy-prod.yml`

### Requirement: Staging readiness gate before upload

Before invoking the upload step, the staging deploy workflow SHALL poll the freshly-deployed runtime's `/readyz` endpoint until it returns HTTP `200`. The poll SHALL use `curl -fsS --retry 30 --retry-delay 5` (or equivalent), yielding a total upper bound of approximately 2.5 minutes. If `/readyz` does not become ready within the retry budget, the step SHALL fail and the upload step SHALL NOT run.

The readiness target URL SHALL be derived from `tofu output -raw url` from `infrastructure/envs/staging/` (same value used by the upload step).

#### Scenario: Probe succeeds after rollout

- **GIVEN** the Deployment rollout completes within the retry budget
- **WHEN** the readiness step polls `<staging-url>/readyz`
- **THEN** the step SHALL observe a `200` response
- **AND** SHALL exit `0`
- **AND** the upload step SHALL proceed

#### Scenario: Probe timeout fails the deploy

- **GIVEN** `/readyz` never returns `200` within the retry budget
- **WHEN** the readiness step exhausts its retries
- **THEN** the step SHALL exit non-zero
- **AND** the upload step SHALL NOT run
- **AND** the deploy job SHALL fail

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

