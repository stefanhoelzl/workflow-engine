## Why

There is no CI/CD automation. Linting, type checking, and tests only run locally, and Docker images must be built and pushed manually. This creates risk of broken code landing on main and makes releases a manual, error-prone process.

## What Changes

- Add a GitHub Actions CI workflow that runs lint, type check, tests, and build on every pull request
- Add a GitHub Actions release workflow triggered by pushing a `release` tag that:
  - Deletes the `release` tag so it can be reused
  - Computes a calver version tag (vYYYY.MM.DD[.N]) from the commit's committer date
  - Builds and pushes a Docker image to GitHub Container Registry (ghcr.io)
  - Pushes the calver git tag to the repository

## Capabilities

### New Capabilities
- `ci-workflow`: GitHub Actions workflow for pull request validation (lint, check, test, build)
- `release-workflow`: GitHub Actions workflow for automated releases triggered by a reusable `release` tag, producing calver-tagged Docker images

### Modified Capabilities

None.

## Impact

- New files: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Requires GitHub Container Registry (ghcr.io) to be enabled for the repository
- Workflow needs `contents: write` and `packages: write` permissions
- No changes to application code, build system, or existing specs
