## Context

The project has no CI/CD automation. Developers run `pnpm lint`, `pnpm check`, and `pnpm test` locally before merging. Docker images are built manually from the existing multi-stage Dockerfile (node:24-slim build stage, distroless runtime). There is no automated release process or version tagging scheme.

The project uses pnpm with corepack, targets Node.js 24+, and is structured as a monorepo with `packages/runtime` as the main package.

## Goals / Non-Goals

**Goals:**
- Automated PR validation (lint, check, test, build) on every pull request
- Automated Docker image release triggered by a reusable `release` git tag
- Calver version tagging (vYYYY.MM.DD[.N]) derived from commit date
- Images published to GitHub Container Registry

**Non-Goals:**
- Multi-platform image builds (amd64 only for now)
- Deployment automation (out of scope)
- Release notes or GitHub Releases
- Running CI on push to main (PRs only)

## Decisions

### Two separate workflow files

CI and release have different triggers, different jobs, and different lifecycles. Separate files (`ci.yml`, `release.yml`) keep each focused and independently maintainable.

Alternative: single workflow with conditional jobs. Rejected because mixing `on: pull_request` and `on: push: tags` in one file makes the trigger logic harder to reason about.

### Reusable `release` tag as trigger

Instead of triggering on version tags (e.g. `v*`), the release workflow triggers on a single `release` tag that gets deleted and recreated each time. This is simpler than maintaining a version bump process — the developer just pushes `release` to any commit.

Alternative: trigger on `v*` tags, requiring the developer to compute and push the calver tag manually. Rejected because it duplicates the version logic that the workflow can automate.

### Calver from committer date

The version tag is derived from the **committer date** of the tagged commit (not author date, not workflow run date). This ties the version to when the code last landed on the branch, which is more meaningful than when CI happened to run.

Format: `vYYYY.MM.DD` with automatic `.N` suffix (starting at `.1`) if a tag for that date already exists. This handles multiple releases per day without manual intervention.

### SHA-based checkout

The workflow checks out code using the default `github.sha` (set at trigger time), then deletes the `release` tag. Since `actions/checkout` defaults to the triggering SHA, this is safe — the tag deletion happens after checkout and doesn't affect the working copy. The GITHUB_TOKEN-triggered tag deletion does not re-trigger the workflow (GitHub's anti-recursion guard).

### Docker tooling: official actions

Using `docker/login-action`, `docker/setup-buildx-action`, and `docker/build-push-action`. These are the standard GitHub Actions for Docker workflows, support layer caching, and handle GHCR authentication via GITHUB_TOKEN.

Alternative: raw `docker build` + `docker push` shell commands. Rejected because the official actions provide caching and better error handling out of the box.

### Image tagging

Docker images are tagged with:
- `YYYY.MM.DD[.N]` (calver without `v` prefix — Docker convention)
- `latest` (always points to the most recent release)

### CI as a single job with sequential steps

Lint, check, test, and build run as sequential steps in one job rather than parallel jobs. This is simpler, avoids redundant checkout/install overhead, and the total runtime is acceptable for this project size. pnpm store is cached via `actions/setup-node`.

## Risks / Trade-offs

- **[Risk] `release` tag pushed to wrong commit** → The calver tag and image will be built from that commit. Mitigation: developer can delete the calver tag and re-push `release` to the correct commit.
- **[Risk] Calver date collision with build number overflow** → Extremely unlikely (would require >N releases in one day). No mitigation needed.
- **[Risk] GHCR push failure after calver tag is computed** → The calver git tag push happens after the image push, so a partial failure won't leave an orphaned version tag. The `release` tag is already deleted at this point, so re-triggering requires re-pushing it.
- **[Trade-off] No CI on main branch** → Direct pushes to main are not validated. Acceptable given the team workflow (PR-based).
