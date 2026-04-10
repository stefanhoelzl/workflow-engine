## REMOVED Requirements

### Requirement: WORKFLOW_DIR config variable
**Reason**: Workflows are now loaded from the storage backend or held in memory, not from a local directory.
**Migration**: Remove `WORKFLOW_DIR` from all deployment configurations. Workflows are uploaded via `POST /api/workflows` and persisted in the storage backend.

## ADDED Requirements

### Requirement: GITHUB_USER config variable

The config schema SHALL accept an optional `GITHUB_USER` environment variable. When provided, the GitHub authentication middleware SHALL be enabled on `/api/*` routes.

#### Scenario: GITHUB_USER is set

- **WHEN** `createConfig` is called with `{ GITHUB_USER: "stefanhoelzl" }`
- **THEN** the config SHALL contain `githubUser: "stefanhoelzl"`

#### Scenario: GITHUB_USER is not set

- **WHEN** `createConfig` is called without `GITHUB_USER`
- **THEN** `githubUser` SHALL be `undefined`
