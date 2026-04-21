## Context

Four OpenTofu projects live under `infrastructure/envs/`: `cluster/`, `persistence/`, `prod/`, `staging/`. After `automate-prod-deployment` lands, `prod/` applies on push to `release` (with approval gate) and `staging/` applies on push to `main` — both are GitOps in the conventional direction (git → CI → reality). `cluster/` and `persistence/` remain operator-applied from a laptop by choice: their blast radius is too large for unattended CI apply (a cluster replacement is a simultaneous prod+staging outage; a persistence misstep corrupts the scoped S3 user that `prod/` reads via `remote_state`).

The cost of keeping these manual is drift: `main` can silently disagree with live state whenever an operator applies and forgets to commit, or when somebody edits the UpCloud console out-of-band. The interview resolved that the right shape is not auto-apply, not scheduled reconciliation, and not a cron drift alert — it is a PR merge-gate: a `tofu plan -detailed-exitcode` check on every PR to `main` that must produce an empty plan against both projects before the PR can merge. This makes `main` a ledger that is provably equal to reality at merge time.

Relevant existing constraints the design has to honour:

- Encrypted state on S3 (`tofu-state` bucket on UpCloud Object Storage) with `use_lockfile = true`. Read-only plans don't need the lock; apply does.
- `envs/cluster/` consumes `TF_VAR_upcloud_token` as a declared variable; `envs/persistence/` declares no `upcloud_token` variable and no `provider "upcloud"` block — the UpCloud provider inside its module picks up the `UPCLOUD_TOKEN` env var directly.
- `envs/cluster/terraform.tfvars` commits `acme_email`; `envs/persistence/terraform.tfvars` commits `service_uuid`, `service_endpoint`, `bucket_name`. Neither has secrets in tfvars.
- Repo already has `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` secrets used by the prod/staging deploy workflows.
- Existing workflows (`deploy-prod.yml`, `deploy-staging.yml`) establish a convention: `opentofu/setup-opentofu@v2`, `actions/checkout@v6`, plan output piped into `$GITHUB_STEP_SUMMARY`.

## Goals / Non-Goals

**Goals:**
- Make it impossible to merge a PR to `main` while `cluster/` or `persistence/` has a non-empty plan against live state.
- Give reviewers one-click visibility into *what* drifted, without needing to check out the branch and run `tofu plan` locally.
- Add no new secrets and no new external dependencies.
- Keep the workflow trivially extensible to future operator-driven projects (one-line matrix addition).

**Non-Goals:**
- Automating `cluster/` or `persistence/` apply. The gate is explicitly a *merge check*, not a deploy trigger.
- Detecting drift between PRs (scheduled cron). Deferred; the gate alone is enough given this repo's change frequency.
- Detecting drift inside Helm-rendered Kubernetes objects (`kubectl edit` on a Helm-managed Deployment). `tofu plan` cannot see this, and fixing it would require an orthogonal mechanism (Argo CD, kube-drift-detector, etc.).
- Preventing two-operator interleaved applies beyond UpCloud's state lockfile. Mitigation is procedural.
- Gating `envs/prod/`, `envs/staging/`, or `envs/local/`.

## Decisions

### PR merge-gate instead of auto-apply or scheduled reconciliation

**Chosen:** Run `tofu plan -detailed-exitcode` on every PR; block merge on non-empty plan via a required status check.

**Alternatives:**
- *Auto-apply on merge* (staging/prod pattern): rejected. The projects in scope here are precisely the ones whose blast radius makes unattended apply unacceptable.
- *Scheduled cron plan* (drift alert): rejected for v1. Needs an alerting channel the repo doesn't have; adds noise during legitimate apply windows; weaker than a merge-gate for the common failure mode (operator forgets to commit).
- *Keep fully manual, document only*: rejected. Operator memory is not a reliable invariant; the gate costs ~30s of CI per PR and delivers a mechanical guarantee.

The gate's key property: it converts *all* PRs (even unrelated frontend ones) into continuous drift detection. That's a feature — it means drift has a maximum lifetime of "time until next PR."

### `tofu plan -detailed-exitcode -lock=false -no-color`

**Chosen flags and rationale:**
- `-detailed-exitcode`: returns 0 for no-diff, 2 for diff, 1 for error. The GitHub Actions step's native exit-code handling maps this to check pass/fail with no extra shell plumbing.
- `-lock=false`: plan is read-only against state; acquiring the lock would make concurrent PR runs serialize on the state backend and, worse, would contend with an operator running `tofu apply` locally. The lockfile remains enforced for writes via the normal `tofu apply` path.
- `-no-color`: the plan output goes into `$GITHUB_STEP_SUMMARY` as rendered markdown; ANSI escape codes garble it.

**Alternative considered:** `-refresh-only`. Rejected — it refreshes state but doesn't report config-vs-state diffs from local `.tf` edits. A PR that *adds* a resource in code (without applying) would pass `-refresh-only` (no refresh changes) despite clearly being un-applied. `-detailed-exitcode` on full `plan` catches both drift directions.

### Matrix over `[cluster, persistence]` with two parallel status checks

**Chosen:** One workflow file `.github/workflows/plan-infra.yml` with `strategy.matrix.project: [cluster, persistence]`, producing GitHub check names `plan (cluster)` and `plan (persistence)`.

**Rationale:** Matrix keeps setup (checkout, setup-opentofu, `tofu init`) DRY while surfacing two independent status checks — a failure on one project isolates without dragging down the other. Each job runs in parallel on its own runner (~30s end-to-end).

**Alternatives:**
- *Single job planning both*: simpler required-check wiring (one context), but loses parallelism and conflates failure modes in one log.
- *Two separate workflow files*: more YAML, no benefit over matrix.
- *Dynamic project discovery* (e.g., grep `envs/*/` for operator-driven markers): over-engineered. Two-item list is fine; extension is one-line.

### Secret wiring: reuse existing `TF_VAR_*`; also export `UPCLOUD_TOKEN` for persistence

**Chosen:** The workflow's `env:` block sets `TF_VAR_state_passphrase`, `TF_VAR_upcloud_token`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` from existing repo secrets. For the `persistence` matrix leg *only*, it additionally exports `UPCLOUD_TOKEN=${{ secrets.TF_VAR_UPCLOUD_TOKEN }}`.

**Why the extra export:** `infrastructure/envs/persistence/persistence.tf` declares no `variable "upcloud_token"` and no `provider "upcloud"` block; the UpCloud provider inside the object-storage module picks up its token from the `UPCLOUD_TOKEN` env var by default. This is an existing quirk of the project layout (deliberately minimal variable surface in the persistence project); the workflow honours it rather than reshaping persistence.tf.

### Plan output lands in `$GITHUB_STEP_SUMMARY`, nowhere else

**Chosen:** Always pipe `tofu plan` output (stderr+stdout) through an `hcl` code fence into the step summary. No PR sticky comment, no artifact upload, no Slack/email.

**Rationale:**
- Matches the convention established by `deploy-prod.yml`'s plan step.
- Step summary is visible to anyone who can read the run — same audience as the state itself, no additional leakage.
- PR comment bots need a token with pull-request write permissions and create history clutter when the plan shape changes noisily (e.g., ACME certificate serial rotation producing a diff that renders and then disappears).
- Artifacts add download friction for zero benefit over inline markdown.

### `pull_request` trigger, not `pull_request_target`

**Chosen:** `on: pull_request: { branches: [main] }`.

**Rationale:** Standard-safe default. `pull_request_target` runs on the target branch's code with write tokens, which is the classic fork-takeover vector; this repo has no external contributors today, so the fork-secrets-access reason to use `pull_request_target` doesn't apply. If the repo ever opens to fork PRs, the gate will fail-closed on them (no secrets → plan errors → check fails → merge blocked) — that's the correct behavior until a maintainer explicitly opts a fork PR in.

### Run unconditionally on every PR to `main` (no path filter, no draft skip)

**Chosen:** No path filter. No `if: !github.event.pull_request.draft`.

**Rationale:**
- Required status checks + path filters interact awkwardly: a skipped required check reads as "pending" and blocks merge forever, requiring either `paths-filter` action gymnastics or branch-protection `requires_when_expected` semantics that aren't well-supported across GitHub APIs.
- Running always turns the gate into continuous drift detection: a pure-frontend PR that runs on a day someone edited the UpCloud console will catch that drift. Higher signal, lower operational complexity.
- Draft PRs: skipping them saves ~30s per draft push but risks a stale "last run was green" signal when the PR is moved to ready. Simpler to always run.
- Cost: two concurrent ~30s jobs per PR event. Negligible.

### Enforce via a GitHub branch ruleset, not the legacy branch-protection API

**Chosen:** Add both status checks to the existing `main` ruleset's `required_status_checks` rule. `bypass_actors` stays empty — no per-PR admin bypass. As part of the same migration, replace the legacy `release` branch protection with a new `release` ruleset (rules: `deletion`, `non_fast_forward`, no bypass) and delete the obsolete `releases` tag ruleset (left over from the retired calver-tag mechanism in `automate-prod-deployment`).

**Rationale:**
- Rulesets are GitHub's current recommended model (as of 2023+); the legacy `branches/<branch>/protection` API is in maintenance mode and less layerable. Rulesets are manageable via `gh api repos/:owner/:repo/rulesets` with stable, versioned JSON bodies.
- The `main` repo already had a ruleset covering deletion, non-fast-forward, linear history, PR (rebase-only, threads must resolve), and status checks (`ci`, `docker-build`, `wpt`). Adding two more contexts to the same `required_status_checks` rule is a one-field edit, cleaner than a parallel ruleset (which could drift out of sync).
- `bypass_actors: []` is deliberate. No per-PR admin bypass. The prior sketch of this design assumed admin-bypass would be the escape hatch; the chosen approach treats the gate as strictly enforced.

**Escape hatch when the gate is broken.** Because no per-PR bypass exists, the emergency procedure for a broken workflow is:

1. If the failure is credential-only (expired token, secret rotation), `gh secret set TF_VAR_UPCLOUD_TOKEN` (or equivalent). No merge needed; the next PR push re-triggers the workflow with the new secret.
2. If the failure is in the workflow file itself, `gh api --method PUT repos/:owner/:repo/rulesets/<main-ruleset-id>` with `enforcement: "disabled"`, merge the fix, then `PUT` again with `enforcement: "active"`. Leaving the ruleset in `disabled` state bypasses ALL of main's rules (including deletion and force-push blocks), so flip it back promptly.

**One-time bootstrap order:** the ruleset can be updated before the workflow exists because ruleset status-check contexts are identifiers (strings), not references to historical runs — GitHub's API accepts any string. Until the workflow runs on a PR, those two required checks would block every merge (they'd be reported as pending). In practice this means: update the ruleset *and* merge the introducing PR together — the introducing PR's own head branch carries `plan-infra.yml`, so the workflow runs on its own PR and reports the contexts, unblocking that very PR.

### Two-operator race: procedural mitigation, not code

**Chosen:** Document in `CLAUDE.md`: `git pull --rebase origin main` before running `tofu apply` on `cluster/` or `persistence/`.

**Rationale:** UpCloud state lockfile serializes *simultaneous* applies, but *sequential* applies from stale branches (Bob applies from a branch missing Alice's change → Bob's apply reverts Alice's change) aren't a lock problem — they're a rebase problem. Building a CI-side detector (e.g., comparing local apply's planned state hash against remote HEAD's) is well beyond v1 scope and would duplicate what `git rebase` already achieves for free. Accept the procedural rule; the gate at least catches the result (Alice's next PR shows non-empty plan) so nothing reaches `main` silently.

## Risks / Trade-offs

- **Drift caught by unrelated PRs blocks unrelated work.** A frontend PR can be held hostage by cluster drift someone else caused. → Expected and intentional (continuous drift detection). Documented in CLAUDE.md so the operator knows the remediation is "apply locally to match main" or "commit the drift."
- **Broken workflow blocks all merges.** Expired `UPCLOUD_TOKEN`, UpCloud API outage, or a regression in `plan-infra.yml` itself blocks every PR including the fix PR. → No per-PR bypass; recovery is either secret-rotation via `gh secret set` (no merge needed) or temporarily flipping the ruleset to `enforcement: "disabled"` via `gh api PUT`, merging the fix, and flipping back. Documented in CLAUDE.md.
- **Two-operator race silently reverts work.** As described above. → Procedural `git pull --rebase` rule in CLAUDE.md. Gate catches the inconsistency on the next PR.
- **Drift inside Helm-managed objects is invisible.** `kubectl edit` on a Traefik Deployment won't show in `tofu plan`. → Documented in CLAUDE.md as a known gap; operators should not bypass Helm. Future work can add a separate drift-detection mechanism if the gap bites.
- **Plan flakes from transient UpCloud API errors cause false-negative check failures.** → Operator re-runs the GitHub Actions job. No code-side retry logic added — simplicity over theoretical robustness.
- **Cost grows with matrix size.** If a future operator-driven project is added, the matrix runs another parallel job per PR. → Linear in project count; fine for the foreseeable future.

## Migration Plan

1. Merge the workflow without the ruleset. The check runs on the workflow's own introducing PR (should be empty-plan green, assuming the live cluster matches `main` at PR time — operator verifies locally first by running `tofu plan` against both projects before opening the PR).
2. After at least one run exists, create the ruleset via `gh api repos/:owner/:repo/rulesets` (command body documented in CLAUDE.md).
3. From this point forward, all PRs to `main` are gated.

**Rollback:** Delete the ruleset via `gh api --method DELETE repos/:owner/:repo/rulesets/<id>`; optionally remove `plan-infra.yml`. No state backend changes, no infrastructure changes, no data migration — the gate is purely additive CI + GitHub config.
