## 1. Pre-flight

- [x] 1.1 Confirm live state matches `main` by running `tofu plan` locally for both `infrastructure/envs/cluster/` and `infrastructure/envs/persistence/`; if either shows a diff, resolve (apply or commit) before proceeding so the workflow's first run passes cleanly
- [x] 1.2 Verify the existing repo secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN` are present in the target repository's Actions secrets UI

## 2. Workflow implementation

- [x] 2.1 Create `.github/workflows/plan-infra.yml` with the top-level fields: `name: Plan infra`, `on: pull_request: { branches: [main] }`, `permissions: { contents: read }`, and a `concurrency` group keyed by `github.ref` with `cancel-in-progress: true`
- [x] 2.2 Define a single `plan` job with `strategy: { matrix: { project: [cluster, persistence] } }` and `runs-on: ubuntu-latest`
- [x] 2.3 Add steps: `actions/checkout@v6`, `opentofu/setup-opentofu@v2`, a `tofu init` step (working directory `infrastructure/envs/${{ matrix.project }}`), and a plan step running `tofu plan -detailed-exitcode -lock=false -no-color` whose output is piped into `$GITHUB_STEP_SUMMARY` wrapped in an `hcl` fenced code block (same pattern as `deploy-prod.yml`'s plan step)
- [x] 2.4 Set the `env:` block on both the init and plan steps: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_state_passphrase`, and `TF_VAR_upcloud_token` mapped from the corresponding secrets; also set `UPCLOUD_TOKEN: ${{ secrets.TF_VAR_UPCLOUD_TOKEN }}` so the persistence leg's module-level UpCloud provider authenticates (the cluster leg ignores this extra var)
- [x] 2.5 Ensure the plan step preserves the `tofu plan` exit code so the job fails on non-zero (do NOT swallow the exit code inside a subshell or a `|| true` chain; capture stdout/stderr into the summary and re-propagate the exit code)

## 3. Bootstrap the gate

- [ ] 3.1 Open a PR to `main` introducing `plan-infra.yml`; verify the two status checks `plan (cluster)` and `plan (persistence)` both report success on the PR before merging
- [ ] 3.2 Merge the workflow PR

## 4. Ruleset

- [x] 4.1 ~~After the workflow has reported at least once (step 3.1),~~ Added `plan (cluster)` and `plan (persistence)` to the existing `main` ruleset (id=14783293) via `gh api PUT`, with `strict_required_status_checks_policy: true` and `bypass_actors: []` (no bypass, per user decision). Also migrated `release` legacy branch protection to a new ruleset (id=15360852, rules: deletion + non_fast_forward, no bypass) and deleted the obsolete `releases` tag ruleset (id=14783256) left over from the retired calver-tag mechanism.
- [ ] 4.2 Verify the ruleset is active by opening a dummy PR that intentionally creates a plan diff (e.g., add a no-op comment to a module and DO NOT apply) and confirming the merge button blocks until the diff is reverted

## 5. Documentation

- [x] 5.1 Add an "Operator flow for manual infrastructure projects" subsection under `## Production` in `CLAUDE.md` covering: (a) the apply-first-then-PR sequence, (b) the `git pull --rebase origin main` rule before running `tofu apply` on cluster/persistence to avoid the two-operator race, (c) the known gap that `tofu plan` does not detect raw `kubectl`-level drift inside Helm-managed releases, (d) the ruleset admin-bypass as the sole escape hatch if the gate itself breaks, and (e) the one-line matrix extension for onboarding a future operator-driven project
- [x] 5.2 Add an entry to the `## Upgrade notes` section of `CLAUDE.md` for this change (non-breaking, additive CI + GitHub ruleset) so future readers understand when the gate appeared
