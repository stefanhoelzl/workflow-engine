## REMOVED Requirements

A single shared **Reason / Migration** applies to every removed requirement in this section unless otherwise noted:

- **Reason**: The deploy seam moves from "tofu apply pins a digest" to "tag-based `podman-auto-update.timer`". Tofu is no longer in the per-deploy path. Per-deploy CI shrinks to `docker build && docker push`. The four-job pre-merge plan-gate matrix collapses to a single job because there is one tofu project.
- **Migration**: See ADDED Requirements below for the new shape.

### Requirement: Staging tofu apply step
### Requirement: Staging deploy serialization
### Requirement: First staging deploy bootstrap
### Requirement: Prod tofu plan rendered to job summary
### Requirement: Prod tofu apply step
### Requirement: Prod post-apply certificate readiness check
### Requirement: Prod deploy serialization
### Requirement: First prod deploy migration bootstrap
### Requirement: Infra plan gate secret wiring

## MODIFIED Requirements

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

The system SHALL provide a GitHub Actions workflow at `.github/workflows/deploy-prod.yml` that runs on every push to the `release` branch. The workflow SHALL declare `environment: production` so a required reviewer must approve before any step runs. After approval, the workflow SHALL build the runtime image with `--build-arg GIT_SHA=${{ github.sha }}` and push it to `ghcr.io/stefanhoelzl/workflow-engine:release`. The workflow SHALL NOT invoke `tofu` in any step. The workflow SHALL NOT upload any demo bundle.

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

The GitHub repository SHALL define exactly the secrets required by the prod deploy workflow. After this change the prod deploy workflow needs no tofu secrets, no SSH key, no UpCloud token, no Dynu key, no AWS state credentials. The default `GITHUB_TOKEN` is sufficient for `docker push`. The `production` GitHub Environment SHALL require at least one reviewer before any step runs.

#### Scenario: No infra secrets referenced by deploy-prod

- **WHEN** `.github/workflows/deploy-prod.yml` is inspected
- **THEN** `TF_VAR_*`, `AWS_*`, `UPCLOUD_*`, `SCW_*`, `DYNU_*`, and `DEPLOY_SSH_PRIVATE_KEY` SHALL NOT appear

#### Scenario: Approval required before any step

- **WHEN** a reviewer has not approved the `production` environment gate
- **THEN** every step SHALL remain pending (subject to GitHub's default 30-day timeout)

### Requirement: Infra plan gate workflow trigger

The repository SHALL provide a GitHub Actions workflow at `.github/workflows/plan-infra.yml` that runs on every `pull_request` event targeting the `main` branch. The workflow SHALL run a single job that operates against the single `infrastructure/` project (no matrix). The workflow SHALL NOT trigger on any other event (no `push`, no `schedule`, no `workflow_dispatch`).

#### Scenario: PR opened against main

- **WHEN** a contributor opens a pull request whose base branch is `main`
- **THEN** the workflow triggers and produces one status check named `plan (vps)`

#### Scenario: PR opened against release branch

- **WHEN** a contributor opens a pull request whose base branch is `release`
- **THEN** the workflow does NOT trigger

#### Scenario: Push to main

- **WHEN** a commit is pushed directly to `main`
- **THEN** the workflow does NOT trigger

### Requirement: Infra plan gate uses detailed exit codes

The single `plan (vps)` job SHALL invoke `tofu plan -detailed-exitcode -lock=false -no-color` in `infrastructure/` after `tofu init`. The job SHALL pass when `tofu plan` returns exit code 0 (no diff). The job SHALL fail when `tofu plan` returns exit code 1 (error) or 2 (diff present). The infra is operator-applied (`changes-allowed: false`); a non-empty plan means the operator has not yet applied a base change.

The job SHALL provide a runner-local `/tmp/wfe-secrets/` directory containing dummy env file content (e.g. all-zero secrets) before invoking tofu, so the `null_resource` env-file `filemd5(...)` triggers can be evaluated at plan time without leaking real secret values into PR plans.

#### Scenario: Plan shows no diff

- **WHEN** `tofu plan -detailed-exitcode` returns exit code 0 against `infrastructure/`
- **THEN** the job succeeds and `plan (vps)` reports success

#### Scenario: Plan shows a diff

- **WHEN** `tofu plan -detailed-exitcode` returns exit code 2 (the operator has not applied the change yet)
- **THEN** the job fails and `plan (vps)` reports failure, blocking merge

#### Scenario: Plan errors out

- **WHEN** `tofu plan` returns exit code 1 (provider misconfig, expired token, backend unreachable)
- **THEN** the job fails

### Requirement: Infra plan output rendered into step summary

The single `plan (vps)` job SHALL pipe the full `tofu plan` output into `$GITHUB_STEP_SUMMARY` wrapped in an `hcl` fenced code block, regardless of exit code. The workflow SHALL NOT post PR comments, upload plan artifacts, or send notifications to external channels.

#### Scenario: Reviewer inspects a failed plan check

- **WHEN** a reviewer opens the failed GitHub Actions run for the `plan (vps)` check
- **THEN** the run's Summary tab displays the full plan diff as rendered markdown without requiring the reviewer to re-run `tofu plan` locally

#### Scenario: Passing plan still renders summary

- **WHEN** the plan is empty and the check passes
- **THEN** the Summary still contains the (empty) plan output so reviewers can confirm by inspection

### Requirement: Main branch ruleset requires both plan checks

The repository's `main` branch ruleset SHALL list `plan (vps)` in its `required_status_checks` rule, with `strict_required_status_checks_policy: true`. The ruleset SHALL declare `bypass_actors: []` — no per-PR bypass path exists for any user or role. The escape hatch for a broken gate is to temporarily flip the ruleset's `enforcement` field to `disabled` via `gh api PUT`, merge the fix, and flip it back to `active`.

#### Scenario: PR with failing plan check cannot merge

- **WHEN** a PR targets `main` and `plan (vps)` reports failure
- **THEN** GitHub prevents the merge, regardless of the actor (including repository administrators)

#### Scenario: No per-PR bypass

- **WHEN** any actor attempts to merge a PR whose required check has not passed
- **THEN** the merge is blocked

#### Scenario: Emergency ruleset disable

- **WHEN** the plan workflow itself is broken (regression in workflow file) and a fix PR needs to merge
- **THEN** a repository administrator MAY `gh api --method PUT repos/:owner/:repo/rulesets/<id>` with `enforcement: "disabled"`, merge the fix, and `PUT` again with `enforcement: "active"`; no per-PR merge-button bypass is used

### Requirement: Staging demo workflow upload step

The staging deploy workflow SHALL, after the readiness gate succeeds (see "Staging readiness gate before upload"), upload the monorepo's `workflows/` bundle to the staging runtime at `https://staging.workflow-engine.webredirect.org`. The upload SHALL authenticate as `github:user:stefanhoelzl` using a fine-grained Personal Access Token stored in the repository secret `GH_UPLOAD_TOKEN`, which SHALL be passed to the upload step as the `GITHUB_TOKEN` environment variable. The CLI SHALL auto-detect the target `(owner, repo)` scope from `git remote get-url origin` (yielding `stefanhoelzl/workflow-engine`).

Upload failure SHALL fail the deploy job. The step SHALL NOT use `continue-on-error`.

#### Scenario: Successful deploy uploads demo bundle

- **GIVEN** the readiness gate confirms the new image is running on staging
- **WHEN** the upload step runs
- **THEN** `wfe upload --url https://staging.workflow-engine.webredirect.org` SHALL be invoked against `stefanhoelzl/workflow-engine`
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

Before invoking the upload step, the staging deploy workflow SHALL poll `https://staging.workflow-engine.webredirect.org/readyz` until both of the following hold:

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

## ADDED Requirements

### Requirement: deploy-image composite action

The repository SHALL provide a composite GitHub Action at `.github/actions/deploy-image/` that encapsulates the full per-env deploy: ghcr login → build + push the runtime image (via the existing `docker-build` composite action) → poll the target URL's `/readyz` until `version.gitSha === ${{ github.sha }}`. Both `deploy-prod.yml` and `deploy-staging.yml` SHALL consume it via `uses: ./.github/actions/deploy-image`. Inputs: `tag` (e.g. `release` or `main`), `url` (target URL whose `/readyz` reports the running gitSha), `github_token` (for ghcr auth).

#### Scenario: Both deploy workflows use the shared action

- **WHEN** `.github/workflows/{deploy-prod,deploy-staging}.yml` are inspected
- **THEN** each contains exactly one `uses: ./.github/actions/deploy-image` step
- **AND** that step is the only place the build / push / readyz-poll logic lives
