### Requirement: Release trigger
The system SHALL provide a GitHub Actions workflow at `.github/workflows/release.yml` that triggers when the `release` tag is pushed.

#### Scenario: Release tag pushed
- **WHEN** the git tag `release` is pushed to the repository
- **THEN** the release workflow SHALL start

#### Scenario: Other tag pushed
- **WHEN** any tag other than `release` is pushed
- **THEN** the release workflow SHALL NOT trigger

### Requirement: Delete release tag
The workflow SHALL delete the `release` tag from the remote repository after checkout so it can be reused for future releases.

#### Scenario: Tag deletion
- **WHEN** the workflow has checked out the code
- **THEN** the `release` tag SHALL be deleted from the remote via `git push --delete origin release`

#### Scenario: Tag deletion does not re-trigger
- **WHEN** the `release` tag is deleted during the workflow run
- **THEN** no new workflow run SHALL be triggered (guaranteed by GITHUB_TOKEN anti-recursion)

### Requirement: Calver tag computation
The workflow SHALL compute a calendar version tag from the committer date of the checked-out commit in the format `vYYYY.MM.DD`.

#### Scenario: First release on a given date
- **WHEN** no tag matching `vYYYY.MM.DD` exists for the commit's committer date
- **THEN** the calver tag SHALL be `vYYYY.MM.DD` (e.g., `v2026.04.07`)

#### Scenario: Subsequent release on the same date
- **WHEN** a tag `vYYYY.MM.DD` already exists and N additional `.N` suffixed tags exist
- **THEN** the calver tag SHALL be `vYYYY.MM.DD.{N+1}` (e.g., `v2026.04.07.2` if `.1` exists)

### Requirement: Docker image build and push

The workflow SHALL build a Docker image using `infrastructure/Dockerfile` with the repository root as build context and push it to GitHub Container Registry at `ghcr.io/${{ github.repository }}`.

#### Scenario: Successful image build and push

- **WHEN** the Docker build succeeds
- **THEN** the image SHALL be pushed to GHCR with the calver tag (without `v` prefix) and `latest`

#### Scenario: Image tags

- **WHEN** the computed calver tag is `v2026.04.07`
- **THEN** the Docker image SHALL be tagged as `2026.04.07` and `latest`

#### Scenario: Image tags with build number

- **WHEN** the computed calver tag is `v2026.04.07.1`
- **THEN** the Docker image SHALL be tagged as `2026.04.07.1` and `latest`

#### Scenario: Dockerfile location

- **WHEN** the build step is configured
- **THEN** the `file` parameter SHALL be set to `infrastructure/Dockerfile`
- **AND** the `context` parameter SHALL be `.` (repository root)

### Requirement: Calver git tag push
The workflow SHALL push the computed calver git tag to the repository after the image is successfully published.

#### Scenario: Tag push after image publish
- **WHEN** the Docker image has been pushed to GHCR
- **THEN** the calver git tag SHALL be created on the current commit and pushed to the remote

#### Scenario: Tag push order
- **WHEN** the image push fails
- **THEN** the calver git tag SHALL NOT be pushed (preventing orphaned version tags)

### Requirement: Workflow permissions
The workflow SHALL request `contents: write` (for tag operations) and `packages: write` (for GHCR push) permissions.

#### Scenario: Permissions declared
- **WHEN** the workflow runs
- **THEN** it SHALL have write access to repository contents and packages
