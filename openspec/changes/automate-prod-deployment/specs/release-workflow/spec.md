## REMOVED Requirements

### Requirement: Release trigger

**Reason**: Replaced by the `release` branch push trigger in the `ci-workflow` capability. The `release` git tag is no longer used; prod deploys are triggered by pushing to the long-lived `release` branch.
**Migration**: Delete `.github/workflows/release.yml`. Push to `release` branch instead of pushing the `release` tag. See the prod deploy requirements in the `ci-workflow` spec.

### Requirement: Delete release tag

**Reason**: The `release` tag is no longer used, so there is nothing to delete. The `release` branch is protected against deletion instead.
**Migration**: No migration needed; the step is removed along with the workflow.

### Requirement: Tag deletion does not re-trigger

**Reason**: Obsolete. No tag is deleted because no tag is used.
**Migration**: None.

### Requirement: Calver tag computation

**Reason**: Deploys are identified by immutable image digests and by the commit SHA on the `release` branch, not by calendar version labels. Historical `vYYYY.MM.DD` tags are retained as-is but no new ones are created by this workflow.
**Migration**: If a human-readable release label is needed for a specific deploy, create a git tag manually on the relevant `release` commit; it is no longer produced by CI.

### Requirement: Docker image build and push

**Reason**: Replaced by the prod deploy workflow's build step in the `ci-workflow` capability. Image is now pushed to `ghcr.io/stefanhoelzl/workflow-engine:release` (mutable branch-name tag mirroring staging's `:main`); the digest captured from `docker/build-push-action` is what the apply step consumes.
**Migration**: See the "Prod build and push step" requirement in the `ci-workflow` spec.

### Requirement: Calver git tag push

**Reason**: No calver tag is computed, so nothing to push.
**Migration**: None.

### Requirement: Workflow permissions

**Reason**: Obsolete with the workflow file deleted. The replacement workflow (`deploy-prod.yml`) declares its own permissions in the `ci-workflow` capability.
**Migration**: See the prod deploy workflow's permissions (`contents: read`, `packages: write`).
