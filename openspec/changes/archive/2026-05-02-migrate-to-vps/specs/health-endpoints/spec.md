## ADDED Requirements

### Requirement: Readiness response includes version.gitSha

The `GET /readyz` response body SHALL include a `version` object whose `gitSha` field reflects the build SHA baked into the running image at build time, sourced from the `APP_GIT_SHA` environment variable. The Dockerfile SHALL accept a `GIT_SHA` build-arg and bake it into the image as `ENV APP_GIT_SHA=${GIT_SHA}`. When `APP_GIT_SHA` is unset (e.g. `pnpm dev` without `GIT_SHA`), `gitSha` SHALL be the literal string `"dev"`.

This contract SHALL be load-bearing for the `ci-workflow` capability's "Staging readiness gate before upload" requirement, which polls `/readyz` until `version.gitSha === <github.sha>` to detect that the auto-update timer has rotated to the new image before running `wfe upload`.

#### Scenario: gitSha matches the built image

- **GIVEN** the image is built with `GIT_SHA=abc123`
- **WHEN** an HTTP client requests `GET /readyz` against the running container
- **THEN** the response body's `version.gitSha` SHALL equal `"abc123"`

#### Scenario: gitSha defaults to "dev" in local development

- **GIVEN** the runtime is started via `pnpm dev` with `APP_GIT_SHA` unset
- **WHEN** an HTTP client requests `GET /readyz`
- **THEN** the response body's `version.gitSha` SHALL equal `"dev"`

#### Scenario: gitSha appears on success and failure responses

- **GIVEN** the readiness endpoint can return `200` (pass) or `503` (fail)
- **WHEN** either response is returned
- **THEN** the body SHALL contain `version.gitSha` regardless of overall status
