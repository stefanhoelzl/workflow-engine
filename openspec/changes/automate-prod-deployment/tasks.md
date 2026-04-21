## 1. Infrastructure (envs/prod): switch image_tag → image_digest

- [x] 1.1 In `infrastructure/envs/prod/prod.tf`, replace `variable "image_tag"` with `variable "image_digest" { type = string; description = "Container image digest (sha256:...) supplied at apply time by CI" }` (no default; no `sensitive` flag).
- [x] 1.2 In `infrastructure/envs/prod/prod.tf`, change the `module "app"` block's `image` to `"ghcr.io/stefanhoelzl/workflow-engine@${var.image_digest}"` and `image_hash` to `var.image_digest`.
- [x] 1.3 In `infrastructure/envs/prod/terraform.tfvars`, remove the `image_tag = "..."` line. Keep `domain` and `auth_allow` only.
- [x] 1.4 Run `tofu -chdir=infrastructure/envs/prod init -backend=false && tofu -chdir=infrastructure/envs/prod validate` locally to confirm HCL parses.
- [x] 1.5 Run `tofu fmt -check -recursive infrastructure/` to confirm formatting.

## 2. Workflow: add deploy-prod.yml

- [x] 2.1 Create `.github/workflows/deploy-prod.yml`. Header: `on: { push: { branches: [release] }, workflow_dispatch: {} }`. `concurrency: { group: tofu-prod, cancel-in-progress: false }`. `permissions: { contents: read, packages: write }`.
- [x] 2.2 Job `plan`: `runs-on: ubuntu-latest`. First steps: `actions/checkout@v6`, `docker/login-action@v4` for ghcr.io. (Split into two jobs `plan` + `apply`; see design D3 update — `environment:` is job-level in GHA.)
- [x] 2.3 Build step: `uses: ./.github/actions/docker-build` with `push: "true"` and `tags: ghcr.io/${{ github.repository }}:release`. Capture `steps.build.outputs.digest` and expose as a job output.
- [x] 2.4 Add `opentofu/setup-opentofu@v2` step.
- [x] 2.5 Add a `tofu init` step in `working-directory: infrastructure/envs/prod` with `AWS_*`, `TF_VAR_state_passphrase` env.
- [x] 2.6 Add a `tofu plan -no-color -var image_digest=<digest>` step piping output to `$GITHUB_STEP_SUMMARY` (wrap in ```` ```hcl ```` fences). Full `TF_VAR_*` env block: `upcloud_token`, `dynu_api_key`, `github_oauth_client_id` (from `GH_APP_CLIENT_ID_PROD`), `github_oauth_client_secret` (from `GH_APP_CLIENT_SECRET_PROD`).
- [x] 2.7 Add a second job `apply` with `environment: production` (so the required-reviewer gate fires when `apply` becomes eligible) and `needs: plan`. Job does its own `tofu init` + `tofu apply -auto-approve -var image_digest=${{ needs.plan.outputs.digest }}`. Also expose `cluster_id` via `echo cluster_id=$(tofu output -raw cluster_id) >> $GITHUB_OUTPUT` in the same step.
- [x] 2.8 Add `UpCloudLtd/upcloud-cli-action@v1.0.1` with `version: "3.19.0"` and `token: ${{ secrets.TF_VAR_UPCLOUD_TOKEN }}`. Also export `UPCLOUD_TOKEN` env on the subsequent `upctl` call for redundant auth-independence.
- [x] 2.9 Read `cluster_id` via `tofu output -raw cluster_id` in the apply step (prod.tf now exposes `output "cluster_id"`). Run `upctl kubernetes config <cluster-id> --write ~/.kube/config --write-mode overwrite`.
- [x] 2.10 Add `azure/setup-kubectl@v4` (kubectl is NOT pre-installed on ubuntu-latest per current GHA images). Then add `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m`.
- [x] 2.11 Verify no secrets are echoed in any step's run script (no `echo $SECRET`, no `cat` on a secret file). All secrets consumed via `env:` blocks; `tofu plan -no-color` prints sensitive vars as `(sensitive value)`.

## 3. Retire release.yml

- [x] 3.1 Delete `.github/workflows/release.yml`.
- [x] 3.2 Confirm no other workflow references the `release` tag or the deleted workflow. (Only remaining CLAUDE.md reference is scheduled for rewrite in task 4.4.)

## 4. Documentation

- [x] 4.1 Update `CLAUDE.md` "Production (OpenTofu + UpCloud)" → "Subsequent deploys" → "Prod" section. Replace the "bump `image_tag` in tfvars, run `tofu apply` locally" text with: "push to the `release` branch via `git push origin <commit>:release` (or cherry-pick from `main`); the `deploy-prod.yml` workflow builds the image, runs `tofu plan`, and pauses before apply waiting for reviewer approval in the `production` GitHub Environment."
- [x] 4.2 In the same section, document rollback: "Rollback = `git revert <bad-sha>` on `release`, then `git push origin release` → workflow rebuilds prior code and redeploys."
- [x] 4.3 Update the per-project credentials table in `CLAUDE.md`: remove the `image_tag` mention from the Non-secret tfvars list for prod (prod now has only `domain`, `auth_allow`).
- [x] 4.4 Remove the reference to the `Release` GHA workflow from the prod "Subsequent deploys" section (the workflow no longer exists).
- [x] 4.5 Add a bullet to the "Upgrade notes" section documenting the `automate-prod-deployment` change: the prod image-identity move from `image_tag` to `image_digest`, the retirement of `release.yml`, and the need (for existing operators) to run the first release-branch deploy via CI rather than locally.

## 5. OpenSpec archive prerequisites

- [x] 5.1 Run `pnpm exec openspec validate automate-prod-deployment --type change --strict` — "Change 'automate-prod-deployment' is valid".
- [x] 5.2 Confirmed via `pnpm exec openspec show automate-prod-deployment --type change --json --deltas-only`: 19 deltas parsed (9 ADDED to ci-workflow, 3 MODIFIED on infrastructure, 7 REMOVED from release-workflow).

## 6. Local validation before PR

- [x] 6.1 Run `pnpm lint` and `pnpm check` to confirm no markdown-linting or YAML-adjacent issues in committed files (workflows are not type-checked but committing them should not regress any repo check).
- [ ] 6.2 Commit on a feature branch and open a PR against `main`. PR description MUST call out: (a) first release-branch deploy will roll the prod pod once (session invalidation — same as any prod deploy); (b) the operator needs to fast-forward `release` to merged `main` after merging.

## 7. Post-merge migration (operator steps, not part of the PR)

- [ ] 7.1 After the PR merges to `main` and staging redeploys cleanly, run `git push origin main:release` to fast-forward `release`.
- [ ] 7.2 Watch the `deploy-prod.yml` run in GitHub Actions. Review the plan in the job summary. Approve the apply when ready.
- [ ] 7.3 Confirm the apply succeeds, the pod rolls, and `kubectl wait` reports the Certificate Ready.
- [ ] 7.4 Verify `https://workflow-engine.webredirect.org` serves the new build (check `/healthz` and the dashboard).

## 8. Sanity checks after first automated deploy

- [ ] 8.1 `kubectl -n prod get deploy workflow-engine -o jsonpath='{.spec.template.spec.containers[0].image}'` SHALL print `ghcr.io/stefanhoelzl/workflow-engine@sha256:...` (digest form).
- [ ] 8.2 `gh api repos/{owner}/{repo}/actions/runs --jq '.workflow_runs[0]'` for the `deploy-prod` workflow reports `conclusion: success`.
- [ ] 8.3 Open an intentionally small cherry-pick PR into `main`, merge it, cherry-pick onto `release`, push, and confirm the full pipeline fires and deploys cleanly a second time.
