## Why

The `automate-prod-deployment` change completed the auto-apply pipeline for `envs/prod/` and `envs/staging/`, but `envs/cluster/` and `envs/persistence/` remain deliberately operator-driven — a bad cluster plan would churn the K8s control plane and take down prod AND staging simultaneously, and a bad persistence plan would corrupt the bucket-scoped user that prod depends on via `remote_state`. For these two highest-blast-radius projects we choose to keep `tofu apply` off CI, but nothing currently prevents `main` from drifting away from the live state they describe: an operator can apply locally and forget to commit, or edit the UpCloud console out-of-band, and nobody notices until the next operator tries to apply from a stale tree and silently reverts someone else's work.

Rather than add a reconciliation loop or auto-apply, we make merge itself the enforcement point: every PR to `main` must produce an empty `tofu plan` against `cluster/` and `persistence/`. This inverts the usual GitOps direction — reality is the source of truth; `main` is a ledger that must be provably equal to it at merge time. The operator flow becomes "apply locally → commit → PR → CI replan is empty → merge." Drift cannot accumulate past a merge.

## What Changes

- **NEW**: `.github/workflows/plan-infra.yml` — on every `pull_request` targeting `main`, runs `tofu plan -detailed-exitcode -lock=false -no-color` against a matrix of `[cluster, persistence]`. Exit code 0 (no diff) passes the check; exit code 2 (diff present) fails it; exit code 1 (error) fails it. Plan output is rendered into `$GITHUB_STEP_SUMMARY` for reviewer visibility; no PR comment, no artifact upload. Two parallel jobs produce two status checks: `plan (cluster)` and `plan (persistence)`.
- **NEW (GitHub config, one-time)**: both `plan (cluster)` and `plan (persistence)` added to the existing `main` branch ruleset's `required_status_checks` rule. `bypass_actors` stays empty — no per-PR admin bypass. If the gate itself becomes broken, the escape hatch is to temporarily flip the entire ruleset's `enforcement` from `active` to `disabled` via `gh api PUT`, merge the fix, and flip it back. The same call also created a `release` branch ruleset (rules: `deletion`, `non_fast_forward`, no bypass) to replace the legacy branch-protection API entry previously guarding the `release` branch, and deleted the obsolete `releases` tag ruleset left over from the retired calver-tag mechanism.
- **NEW (secrets wiring)**: the workflow consumes existing repo secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`. The persistence project's module reads the UpCloud token from the `UPCLOUD_TOKEN` env var directly (no provider block in `envs/persistence/persistence.tf`), so the workflow also exports `UPCLOUD_TOKEN` for the persistence matrix leg. No new secrets are introduced.
- **MODIFIED**: `CLAUDE.md` — add an "Operator flow for manual infrastructure projects" subsection documenting the apply-first-then-PR procedure, the `git pull --rebase` rule to avoid silently reverting another operator's apply, the known gap (plan does not detect raw `kubectl`-level edits inside Helm-managed releases), the ruleset admin-bypass escape hatch, and the one-line change required to onboard a future manual project (extend matrix + ruleset).
- **NOT CHANGED**: `envs/prod/` and `envs/staging/` are excluded from the gate by design. Their plans are deliberately non-empty pre-merge (the merge is what triggers their apply); gating them would deadlock. `envs/local/` is excluded because it is developer-laptop-only and has no shared state.
- **OUT OF SCOPE**: scheduled cron-based drift detection (add later as an additive workflow if the absence bites); PR-plan previews for prod/staging (their deploy workflows already render plans).

## Capabilities

### New Capabilities

(none — the PR plan gate is covered by extending the existing `ci-workflow` capability, which already houses PR validation, staging deploy, and prod deploy requirements.)

### Modified Capabilities

- `ci-workflow`: Add requirements for the PR plan-gate workflow (matrix over `[cluster, persistence]`, `tofu plan -detailed-exitcode`, step-summary output, parallel status checks, required-check wiring via ruleset on `main`). The existing PR-validation, staging-deploy, and prod-deploy requirements are unchanged.

## Impact

**Code / files**
- NEW: `.github/workflows/plan-infra.yml`
- MODIFIED: `CLAUDE.md` (Production section — new "Operator flow for manual infrastructure projects" subsection)
- MODIFIED: `openspec/specs/ci-workflow/spec.md` (add PR-plan-gate requirements)

**External systems / one-time setup**
- GitHub ruleset wiring (already applied): the existing `main` ruleset's `required_status_checks` now includes `plan (cluster)` and `plan (persistence)` alongside the pre-existing `ci`, `docker-build`, `wpt`. No bypass actors. A new `release` ruleset replaces the legacy branch-protection entry with equivalent deletion + force-push blocks. The obsolete `releases` tag ruleset is deleted.
- Repo secrets already in place (`AWS_*`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`) — no new secrets needed.

**Operational impact**
- **Merge friction when drift exists.** Any PR (even a pure-frontend one) that opens while `main` disagrees with reality gets blocked until the drift is resolved (apply locally to match `main`, or commit the drift). This is intentional — it converts the gate into continuous drift detection — but authors should expect occasional "my PR is blocked by unrelated cluster drift" moments.
- **Two-operator race (documented, not prevented).** If Alice applies cluster change A locally, and Bob simultaneously applies change B from a branch that lacks A, UpCloud state lockfile serializes the applies but Bob's apply will revert A because his code doesn't contain it. The gate catches this (Alice's PR shows a non-empty plan when she rebases), but Alice's original apply is lost. Mitigation is procedural: rebase on `main` before `tofu apply`. Documented in `CLAUDE.md`.
- **Escape hatch if the gate is broken.** If `UPCLOUD_TOKEN` expires, UpCloud's API is down, or the workflow itself regresses, every PR to `main` is blocked. Because `bypass_actors` is empty (deliberate), there is NO per-PR admin bypass. Credential-rotation fixes (e.g., refreshing `TF_VAR_UPCLOUD_TOKEN`) can be applied directly via `gh secret set` without merging; the next PR push re-triggers the workflow with the new credentials. If the workflow file itself needs fixing, the recovery procedure is: `gh api --method PUT repos/:owner/:repo/rulesets/<main-ruleset-id>` with `enforcement: "disabled"`, merge the fix, then flip back to `enforcement: "active"`. Do not leave the ruleset disabled.
- **Known gap.** `tofu plan` detects drift only in Terraform-managed fields: Helm chart versions, module arguments, K8s manifests declared by Terraform. Raw `kubectl edit` against objects *inside* a Helm release (e.g., hand-editing the Traefik Deployment) produces drift the gate cannot see, because Terraform tracks the Helm release version, not its rendered objects. This is an accepted limitation; operators should not bypass Helm.

**Out of scope**
- Scheduled cron-based drift detection.
- PR-plan previews for `envs/prod/` or `envs/staging/`.
- Coverage for `envs/local/`.
- Automated conflict detection for concurrent operator applies beyond UpCloud state lockfile + the procedural rebase rule.
