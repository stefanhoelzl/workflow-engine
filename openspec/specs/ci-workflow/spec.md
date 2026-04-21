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
The workflow SHALL run `pnpm build` to produce the production build via Vite.

#### Scenario: Build succeeds
- **WHEN** the Vite build completes without errors
- **THEN** the step SHALL succeed and the workflow SHALL report success

#### Scenario: Build fails
- **WHEN** the Vite build fails
- **THEN** the step SHALL fail and the workflow SHALL report failure

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

