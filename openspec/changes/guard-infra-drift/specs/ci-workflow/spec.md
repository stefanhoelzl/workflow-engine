## ADDED Requirements

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
