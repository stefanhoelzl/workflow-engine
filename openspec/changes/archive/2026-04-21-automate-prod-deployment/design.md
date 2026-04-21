## Context

Prod deploys today are two steps operated by a human: (1) push the `release` git tag, which runs `.github/workflows/release.yml` to build + push a calver-tagged image (`v2026.04.19`, `latest`) and create a dated git tag; (2) edit `image_tag` in `infrastructure/envs/prod/terraform.tfvars` and run `tofu apply` locally. Staging, in contrast, is fully automated: every push to `main` builds, captures the image digest from `docker/build-push-action`, and runs `tofu apply -var image_digest=...` on `envs/staging/`.

The resulting asymmetry has three concrete costs:
- **Cherry-pick friction.** Shipping a bugfix to prod requires rebasing prod's history in the operator's head: what commit built `image_tag = "2026.04.19"`? Is main's current tip safe to release? The answer is never in git.
- **Mutable image reference.** Prod resolves `:tag` at pull time; nothing in the cluster state records the exact bytes deployed.
- **Manual tofu apply.** Encourages tfvars edits on the operator's workstation without peer review, bypasses the state-encryption + S3-lock discipline that CI already exercises for staging.

The `release.yml` + dated-tag machinery adds ceremony without solving any of these. This change retires it and promotes a long-lived `release` branch to the source of truth for prod, mirroring the `main` → staging contract.

## Goals / Non-Goals

**Goals:**
- Every prod deploy is a single commit on a protected branch (`release`) with an immutable digest-pinned image. The deployed state is reproducible from `git log release` + GHCR.
- Cherry-picking a bugfix is `git cherry-pick <sha> && git push origin release` + one GitHub UI approval.
- No operator-side state-bearing tools (`tofu apply` on a laptop) for routine prod deploys.
- Runtime observability: the workflow surfaces failed cert issuance inside the same run, not on the next user visit.
- Secret blast radius is bounded by a GitHub Environment (`production`) with a required-reviewer gate.

**Non-Goals:**
- Changing the staging workflow (no cert wait, no two-phase plan, no new secrets).
- Automating `envs/cluster/` or `envs/persistence/` applies. They remain operator-driven — their failure modes (destructive provider operations, Helm chart upgrades that need manual CRD apply) don't benefit from a branch-push gesture.
- Multi-replica prod. The `replicas = 1` constraint in `app-instance/workloads.tf` is load-bearing for the in-memory JWE sealing key; lifting it is a separate change.
- Image signing / SBOM / Sigstore attestation.
- Moving prod secrets into the `production` GitHub Environment namespace. Repo-level secrets are reused as-is (explicit decision: we already trust the repo perimeter; an Environment-scoped secret store adds friction without moving the threat needle for a solo-maintainer repo).

## Decisions

### D1. Trigger = push to a long-lived `release` branch (not a git tag)

The release-tag-driven model makes a tag the canonical deployment marker. That works when releases are rare and calendar-driven. It breaks for the cherry-pick workflow: tagging a commit that isn't main's tip is socially awkward, and the calver scheme (`v2026.04.19`, `.1`, `.2`) leaks deploy ordering into version identifiers.

A long-lived `release` branch gives us:
- Linear history per deploy (`git log release`).
- A natural cherry-pick target.
- Branch protection (no force-push, no deletion) as a cheap way to prevent history rewrites from the CLI.
- The same mental model as `main` → staging (which developers already have).

**Alternatives considered:**
- *Workflow-dispatch with an image digest input.* Rejected: no git provenance for the deployed state; deploy history lives only in GHA run logs. Also puts burden on the operator to specify the right digest.
- *Auto-promote staging on green.* Rejected: prod and staging share the same cluster; a bad staging deploy should not auto-roll prod. Also removes the "I deliberately chose this for prod" signal that the cherry-pick workflow gives us.
- *Keep the `release` tag model, just auto-apply.* Rejected: tag pushes are awkward for cherry-picking, and the calver-tag machinery adds value only as a human-readable label — digests + git log cover that ground.

### D2. Image reference = digest, not tag

Match staging. `image = "ghcr.io/.../workflow-engine@${var.image_digest}"`. Digest is injected at apply time by the workflow; nothing prod-specific is committed.

**Trade-off:** the first apply post-migration rolls the pod because the image string changes. Acceptable (see R1).

**Alternative considered:** keep `image_tag`, have CI commit the new tag back to the `release` branch after each deploy. Rejected: CI writing to a protected branch is a permission escape hatch we don't want, and the branch history would become half-human half-bot.

### D3. Two-job split: unattended `plan` → gated `apply`; no tfplan artifact

Initially we considered saving `tofu plan -out=plan.tfplan` as an artifact and having a second job `apply` it. That pattern is stronger in principle (the approved plan is applied verbatim) but introduces two costs: `tfplan` binaries serialize sensitive values in plaintext, and the artifact needs strict retention settings; and the second job has to re-init tofu + re-auth providers anyway, so the "applied exactly what was approved" guarantee is weaker than it sounds (provider-side drift between plan and apply can still cause divergence).

Settled on a **two-job split without an artifact**:

1. **`plan` job** — no `environment:`, runs unattended. Checks out the repo, builds + pushes the image (captures digest as a job output), sets up tofu, runs `tofu init` + `tofu plan -no-color` with the captured digest, and appends the plan text to `$GITHUB_STEP_SUMMARY`.
2. **`apply` job** — declares `environment: production` (required-reviewer gate), `needs: plan` (receives digest via `needs.plan.outputs.digest`). Approval fires when the `apply` job becomes eligible to start, which is *after* `plan` finishes — so the reviewer gets to read the plan output in the run's Summary tab before clicking approve. After approval: fresh `tofu init` + `tofu apply` (implicit re-plan), then the kubeconfig fetch and `kubectl wait`.

This structure is forced by GitHub Actions' rule that `environment:` is a job-level property, not a step-level one. The apply-side re-plan is a trade-off we accept: the reviewer's mental model is "do I trust what this release commit does," which the commit diff + the unattended plan output together answer adequately. The re-init adds ~10-15s of overhead per run.

If provider-side drift between plan and apply ever becomes a concern (unattended operators `kubectl edit`-ing prod), we revisit and switch to a tfplan-artifact-based split. Not today.

### D4. Post-apply `kubectl wait` on the prod Certificate

`tofu apply` returns when K8s resources are reconciled, not when ACME HTTP-01 issuance completes. A misconfigured DNS record, CAA block, or port-80 reachability issue silently produces a `Certificate` stuck in `Issuing`; the app pod is `Ready` but the TLS listener serves an expired or self-signed cert. The existing CLAUDE.md guidance tells operators to run `kubectl wait` after every manual apply — automating that in CI closes a class of post-deploy surprises.

Kubeconfig is fetched at workflow time via the official `UpCloudLtd/upcloud-cli-action@v1` (pinned version). `upctl` reads `UPCLOUD_TOKEN` from the env (we export it from `TF_VAR_UPCLOUD_TOKEN`). Then `upctl kubernetes config <cluster-id> --write ~/.kube/config --write-mode overwrite` writes a kubeconfig for the run; `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m` blocks up to 5 minutes.

Cluster ID comes from the cluster project's remote state output (`cluster_id`), read via a one-shot `terraform_remote_state` data block exposed through a tofu output in `envs/prod/`, or resolved directly in the workflow step via `tofu -chdir=infrastructure/envs/prod output -raw cluster_id`.

**Alternative considered:** skip the wait, same as staging. Rejected for prod specifically — cert issuance failure on prod is user-visible; on staging it's not.

### D5. Concurrency = separate group from staging; serialize prod pushes

`concurrency: { group: tofu-prod, cancel-in-progress: false }`. Different state keys, different namespaces, no shared resources between prod and staging → run in parallel. Within prod, serialize: `cancel-in-progress: false` avoids killing a mid-flight apply, and the FIFO queue preserves the "each cherry-pick deploys in order" semantic the user expects.

**Trade-off:** if N cherry-picks land within minutes, N approval requests queue. The operator can batch multiple fixes into a single cherry-pick commit on `release` to avoid the pileup.

### D6. Rollback = `git revert` on `release`

No force-push, no `tofu apply -var image_digest=<old>` escape hatch documented. Rolling back = `git revert <bad-sha>` → `git push origin release` → approve the workflow → prior code redeploys. Same time-to-recovery as a forward deploy (~2-3 min for build + apply + cert wait).

**Alternative considered:** allow force-push to `release` for emergency rollback. Rejected: branch protection against force-push is the main reason we chose a branch over a tag for auditability. An escape hatch that bypasses it makes the protection performative.

### D7. GHA secret scope = repo-level (not Environment-scoped)

Repo-level secrets get reused (`AWS_*`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`). Two new repo-level secrets added for the prod GitHub OAuth App (`GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_SECRET_PROD`).

**Alternative considered:** scope prod secrets to the `production` Environment. The GitHub Environment only reveals its secrets to jobs that declare `environment: production`. This would limit blast radius if a workflow were compromised. Rejected for now: single-maintainer repo, and the `production` Environment is already gated on a human-click. Worth revisiting if team size grows.

### D8. Retire `release.yml` + calver tag machinery in the same PR

Atomic swap. No dual-writer window. The `release` git tag is self-cleaning today (the existing workflow deletes it after each run) so there's no cleanup step. The `vYYYY.MM.DD` dated tags created by past runs are not touched — they stay as historical markers.

## Risks / Trade-offs

**R1. Migration cutover rolls the prod pod (session invalidation).** The first deploy-prod run flips `image = ".../workflow-engine:${var.image_tag}"` to `image = ".../workflow-engine@${var.image_digest}"`. Even if the built image is bitwise identical to the currently-deployed `2026.04.19`, the container spec string changes → K8s rolls the ReplicaSet → new pod regenerates the in-memory JWE sealing key → all authenticated sessions invalidate. → **Mitigation:** none required; this is the same UX as any prod deploy today. Call it out in the PR description so the human landing it picks a moment.

**R2. Queued approval requests pile up on rapid cherry-picks.** N pushes in a short window → N gated jobs waiting for human click. → **Mitigation:** operator batches cherry-picks into a single commit on `release` when possible; or rejects pending runs in the GHA UI.

**R3. Approval timeout is 30 days.** Unapproved runs sit in the queue, blocking later pushes behind them. → **Mitigation:** explicit reject of stale runs; don't push to `release` without intent to approve shortly.

**R4. `UpCloudLtd/upcloud-cli-action` is a third-party dependency on the apply path.** Supply-chain risk: a compromised action could leak `TF_VAR_UPCLOUD_TOKEN`. → **Mitigation:** pin to a specific version (not `@main`, not `@v1`); the pin is a manual bump, reviewed like any other dependency change. Alternative considered: install `upctl` from the GitHub Release tarball directly with a checksum check; rejected as unnecessary plumbing for a first-party UpCloud action.

**R5. Kubeconfig written to the runner's disk during the wait step.** Short-lived (runner is ephemeral), but the kubeconfig has cluster-admin-equivalent scope. → **Mitigation:** the runner is GitHub-hosted + ephemeral; fetched credentials die with the VM. Explicitly do *not* upload kubeconfig as an artifact.

**R6. `tofu plan` output in job summary may include sensitive values.** Tofu redacts `sensitive = true` values in text plans by default, but diffs of secret-backed K8s resources (e.g. OAuth client secret rotation) could still reveal hash changes. → **Mitigation:** accept that the job summary is visible to repo members with `read` access (same blast radius as the apply output itself).

**R7. `cluster_id` wiring for the `upctl` step.** Getting it via `tofu -chdir=... output -raw cluster_id` couples the workflow to tofu's output serialization; an alternative is hardcoding the cluster ID as a repo variable (not a secret — cluster ID is not sensitive alone). → **Mitigation:** try the tofu-output path first; fall back to a repo variable if brittle.

## Migration Plan

One PR containing everything: workflow, tofu module changes, spec deltas, doc updates, deletion of `release.yml`.

**Pre-merge setup (already done manually):**
- [x] GitHub Environment `production` with repo owner as required reviewer.
- [x] Branch protection on `release` (no force-push, no deletion).
- [x] Repo secrets `GH_APP_CLIENT_ID_PROD` + `GH_APP_CLIENT_SECRET_PROD`.
- [x] `release` branch created from `origin/main`.

**PR merge sequence:**
1. Merge the PR into `main`. Staging redeploys from the merged main as part of its normal flow (`deploy-staging.yml` on push to `main`). Staging validates the tofu-module changes are not catastrophic — except for the prod-specific `prod.tf` changes, staging won't exercise those, so this only catches generic HCL regressions.
2. Fast-forward `release` to the merged `main`: `git push origin main:release`. This is the first `deploy-prod.yml` run. The plan will show:
   - `module.app.kubernetes_deployment_v1.app`: image string changes from `"...:2026.04.19"` to `"...@sha256:<digest>"`, `sha256/image` pod-template annotation changes.
   - variable `image_tag` removed from state; variable `image_digest` added (tofu variables aren't in state, so this is a plan-only diff).
3. Approve the workflow. Apply runs. Pod rolls. `kubectl wait` confirms cert is still Ready (it already is; no issuance needed because the Certificate resource is unchanged). Sessions invalidate; next user visit → re-login.

**Rollback:** if the migration apply fails (unlikely — it's a pure image-string change), the operator can locally run `tofu -chdir=infrastructure/envs/prod apply -var image_digest=<digest-of-current-image>` to recover. If it succeeds but reveals a deeper problem, `git revert` on `release` restores the prior commit; but since the *prior* commit's prod.tf still uses `image_tag`, we'd also need to revert the deleted `image_tag` tfvar line — which is what `git revert` already does. Safe.

## Open Questions

- **Q1.** Should the workflow fail if `kubectl wait` times out, or only warn? Failing blocks later pushes (queue stalls); warning hides real issuance problems. Leaning toward **fail** (5m timeout is generous for renewals; a timeout means something is actually wrong). Re-evaluate after a few deploys if false positives appear.
- **Q2.** Do we expose `cluster_id` as a tofu output on `envs/prod/` or read it from the cluster project's remote state inside the workflow? The workflow already has the necessary S3 + passphrase credentials to read remote state directly via a small HCL snippet, so there's no strict need to output from prod. Will resolve during implementation; doesn't affect the spec.
- **Q3.** Do we keep `image_pull_policy = "IfNotPresent"` in the app-instance module? For digest-pinned images, `IfNotPresent` is fine (a digest never changes meaning). Not touching this in-scope.
