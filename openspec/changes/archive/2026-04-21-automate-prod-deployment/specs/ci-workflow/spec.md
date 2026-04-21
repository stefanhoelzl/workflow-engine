## ADDED Requirements

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
