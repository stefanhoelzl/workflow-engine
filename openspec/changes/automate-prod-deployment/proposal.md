## Why

Prod deploys are currently operator-only: an engineer edits `image_tag` in `envs/prod/terraform.tfvars` and runs `tofu apply` locally after the `release.yml` workflow cuts a calver-tagged image. This blocks cherry-picking bugfixes to prod without ceremony, diverges from the fully-automated staging path (push-to-main → digest-pinned apply), and makes the deployed commit ambiguous (tfvars drift, mutable tag). A `release` long-lived branch that mirrors staging's flow — push → build → plan → gated apply — closes the gap and makes every prod deploy a reviewable commit on a protected branch.

## What Changes

- **NEW**: `.github/workflows/deploy-prod.yml` — triggers on push to the `release` branch. Builds the runtime image (pushed to `ghcr.io/stefanhoelzl/workflow-engine:release` + captured digest), runs `tofu plan` (output rendered into the job summary), then a gated `tofu apply` step inside the `production` GitHub Environment (required reviewer = repo owner). After apply, fetches kubeconfig via `upctl` and blocks on `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod`.
- **BREAKING (infrastructure)**: `infrastructure/envs/prod/` switches from `image_tag` (mutable tag) to `image_digest` (immutable `sha256:...`), matching staging. The prod `terraform.tfvars` loses the `image_tag` line entirely; digest is supplied at apply time via `-var image_digest=...`. Module image string flips from `:${tag}` to `@${digest}`.
- **REMOVED**: `.github/workflows/release.yml` and the associated `release` git tag + `vYYYY.MM.DD` calver-tag mechanism. Deployment history now lives in the git log of the `release` branch plus the digests recorded by each `deploy-prod.yml` run.
- **Git/GH config (one-time, already applied)**: `release` branch created from `main` with protection against force-push and deletion; `production` GitHub Environment created with repo owner as required reviewer; new repo secrets `GH_APP_CLIENT_ID_PROD` + `GH_APP_CLIENT_SECRET_PROD`.
- **Concurrency**: `deploy-prod.yml` uses group `tofu-prod` with `cancel-in-progress: false` (independent of `tofu-staging`, so prod and staging deploy in parallel; successive prod pushes queue in order).
- **Rollback contract**: `git revert` on the `release` branch is the only sanctioned rollback mechanism; the workflow rebuilds from the reverted HEAD and redeploys. No force-push, no manual-apply escape hatch documented.
- **Docs**: `CLAUDE.md` "Subsequent deploys → Prod" section is rewritten to describe the release-branch flow, the removed `image_tag` var, and the revert-based rollback.

## Capabilities

### New Capabilities

(none — the new prod deploy workflow is covered by extending the existing `ci-workflow` capability, which already houses the staging deploy requirements.)

### Modified Capabilities

- `ci-workflow`: Add requirements for the `release`-branch-triggered prod deploy workflow (trigger, build + digest capture, two-phase plan + gated apply, upctl-based kubeconfig + cert wait, concurrency group, required secrets, first-deploy migration bootstrap). The existing PR-validation and staging-deploy requirements are unchanged.
- `infrastructure`: Replace the prod-project's `image_tag`-based image reference with an `image_digest`-based one (mirror staging). Remove the requirement that the operator updates `image_tag` in `prod/terraform.tfvars`; prod digest is now injected at apply time by CI. Update the prod-tfvars content requirement accordingly.
- `release-workflow`: Retire the entire capability. All requirements (release-tag trigger, tag deletion, calver computation, docker build + push with calver/latest tags, calver git tag push, workflow permissions) are removed. The `release-workflow` spec file is deleted on apply.

## Impact

**Code / files**
- NEW: `.github/workflows/deploy-prod.yml`
- DELETED: `.github/workflows/release.yml`
- MODIFIED: `infrastructure/envs/prod/prod.tf` (variable `image_tag` → `image_digest`; module `image = "...@${digest}"`)
- MODIFIED: `infrastructure/envs/prod/terraform.tfvars` (remove `image_tag` line)
- MODIFIED: `CLAUDE.md` (Production section: release-branch flow, rollback, removed operator steps)
- MODIFIED: `openspec/specs/ci-workflow/spec.md` (add prod deploy requirements)
- MODIFIED: `openspec/specs/infrastructure/spec.md` (prod image reference now digest-based)
- DELETED: `openspec/specs/release-workflow/spec.md`

**External systems / one-time setup** (already applied, documented here for completeness)
- GitHub Environment `production` with required reviewer
- Branch protection on `release` (no force-push, no deletion)
- Repo secrets `GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_SECRET_PROD`
- Existing repo secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY` reused as-is

**Operational risks**
- The first release-branch deploy flips the prod container image string from `:tag` to `@digest`, triggering a K8s rolling update of the single `replicas=1` pod. In-memory JWE sealing key is regenerated, so existing authenticated sessions become invalid. Same effect as any prod deploy today — call-out is for operator awareness.
- The `release` branch's HEAD at PR-merge time is the commit that goes to prod; be deliberate about what gets merged.
- `upctl` is installed via the official `UpCloudLtd/upcloud-cli-action` with a pinned version; pin must be bumped deliberately.

**Out of scope**
- Staging workflow changes (no tfplan artifact, no cert wait added to staging).
- `envs/cluster/` and `envs/persistence/` remain operator-driven.
- Multi-replica prod (requires lifting the JWE-key single-replica invariant; tracked separately).
- Image signing / SBOM / provenance attestation.
