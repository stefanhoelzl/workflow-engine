## MODIFIED Requirements

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

### Requirement: Prod deploy secrets

The GitHub repository SHALL define exactly the secrets required by the prod deploy workflow. After this change the prod deploy workflow needs no tofu secrets, no SSH key, no UpCloud token, no Dynu key, and no AWS state credentials. The default `GITHUB_TOKEN` is sufficient for `docker push`; the only additional secret is `BUNNYNET_API_KEY`, used to roll the prod Bunny app forward (the same account key already used by `deploy-staging.yml` and `plan-infra.yml`). The `production` GitHub Environment SHALL require at least one reviewer before any step runs.

#### Scenario: Only the Bunny key is added; no VPS infra secrets

- **WHEN** `.github/workflows/deploy-prod.yml` is inspected
- **THEN** `TF_VAR_*`, `AWS_*`, `UPCLOUD_*`, `SCW_*`, `DYNU_*`, and `DEPLOY_SSH_PRIVATE_KEY` SHALL NOT appear
- **AND** the only deploy secret beyond `GITHUB_TOKEN` SHALL be `BUNNYNET_API_KEY`

#### Scenario: Approval required before any step

- **WHEN** a reviewer has not approved the `production` environment gate
- **THEN** every step SHALL remain pending (subject to GitHub's default 30-day timeout)

### Requirement: Infra plan gate workflow trigger

The repository SHALL provide a GitHub Actions workflow at `.github/workflows/plan-infra.yml` that runs on every `pull_request` event targeting the `main` branch. The workflow SHALL run a single job that operates against the single `infrastructure/` project (no matrix). The workflow SHALL NOT trigger on any other event (no `push`, no `schedule`, no `workflow_dispatch`).

#### Scenario: PR opened against main

- **WHEN** a contributor opens a pull request whose base branch is `main`
- **THEN** the workflow triggers and produces one status check named `plan (infra)`

#### Scenario: PR opened against release branch

- **WHEN** a contributor opens a pull request whose base branch is `release`
- **THEN** the workflow does NOT trigger

#### Scenario: Push to main

- **WHEN** a commit is pushed directly to `main`
- **THEN** the workflow does NOT trigger

### Requirement: Infra plan gate uses detailed exit codes

The single `plan (infra)` job SHALL invoke `tofu plan -detailed-exitcode -lock=false -no-color` in `infrastructure/` after `tofu init`. The job SHALL pass when `tofu plan` returns exit code 0 (no diff). The job SHALL fail when `tofu plan` returns exit code 1 (error) or 2 (diff present). The infra is operator-applied (`changes-allowed: false`); a non-empty plan means the operator has not yet applied a base change.

The job SHALL pass the secret-bearing `TF_VAR_*` inputs (OAuth credentials, `bunnynet_api_key`, `state_passphrase`) from GHA secrets so every per-env Bunny `env` block's content-hash renders at plan time; because those inputs are declared `sensitive` and the token-mint/storage-zone attributes are sensitive, no secret value leaks into the plan. (There is no longer a host env-file dummy-secrets directory — the VPS `null_resource` env-file `filemd5(...)` triggers no longer exist.)

#### Scenario: Plan shows no diff

- **WHEN** `tofu plan -detailed-exitcode` returns exit code 0 against `infrastructure/`
- **THEN** the job succeeds and `plan (infra)` reports success

#### Scenario: Plan shows a diff

- **WHEN** `tofu plan -detailed-exitcode` returns exit code 2 (the operator has not applied the change yet)
- **THEN** the job fails and `plan (infra)` reports failure, blocking merge

#### Scenario: Plan errors out

- **WHEN** `tofu plan` returns exit code 1 (provider misconfig, expired token, backend unreachable)
- **THEN** the job fails

### Requirement: Infra plan output rendered into step summary

The single `plan (infra)` job SHALL pipe the full `tofu plan` output into `$GITHUB_STEP_SUMMARY` wrapped in an `hcl` fenced code block, regardless of exit code. The workflow SHALL NOT post PR comments, upload plan artifacts, or send notifications to external channels.

#### Scenario: Reviewer inspects a failed plan check

- **WHEN** a reviewer opens the failed GitHub Actions run for the `plan (infra)` check
- **THEN** the run's Summary tab displays the full plan diff as rendered markdown without requiring the reviewer to re-run `tofu plan` locally

#### Scenario: Passing plan still renders summary

- **WHEN** the plan is empty and the check passes
- **THEN** the Summary still contains the (empty) plan output so reviewers can confirm by inspection

### Requirement: Main branch ruleset requires both plan checks

The repository's `main` branch ruleset SHALL list `plan (infra)` in its `required_status_checks` rule, with `strict_required_status_checks_policy: true`. (This replaces the former `plan (vps)` check name; the ruleset's required-check name MUST be updated in lockstep with the workflow job rename, or the renamed check blocks all merges.) The ruleset SHALL declare `bypass_actors: []` — no per-PR bypass path exists for any user or role. The escape hatch for a broken gate is to temporarily flip the ruleset's `enforcement` field to `disabled` via `gh api PUT`, merge the fix, and flip it back to `active`.

#### Scenario: PR with failing plan check cannot merge

- **WHEN** a PR targets `main` and `plan (infra)` reports failure
- **THEN** GitHub prevents the merge, regardless of the actor (including repository administrators)

#### Scenario: No per-PR bypass

- **WHEN** any actor attempts to merge a PR whose required check has not passed
- **THEN** the merge is blocked

#### Scenario: Emergency ruleset disable

- **WHEN** the plan workflow itself is broken (regression in workflow file) and a fix PR needs to merge
- **THEN** a repository administrator MAY `gh api --method PUT repos/:owner/:repo/rulesets/<id>` with `enforcement: "disabled"`, merge the fix, and `PUT` again with `enforcement: "active"`; no per-PR merge-button bypass is used

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
