## MODIFIED Requirements

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
