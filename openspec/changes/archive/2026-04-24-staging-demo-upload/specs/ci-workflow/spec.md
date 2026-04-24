## MODIFIED Requirements

### Requirement: Build step
The workflow SHALL run `pnpm build` to produce the production build via Vite. `pnpm build` is aliased to `pnpm -r build`, which SHALL include the `workflows` workspace's bundle build (`wfe build`). A failure to build `workflows/src/demo.ts` or any SDK surface it exercises SHALL fail the PR validation workflow.

#### Scenario: Build succeeds
- **WHEN** every workspace's build (including the `workflows` bundle build) completes without errors
- **THEN** the step SHALL succeed and the workflow SHALL report success

#### Scenario: Build fails
- **WHEN** any workspace's build fails (including a regression that breaks `workflows/src/demo.ts`)
- **THEN** the step SHALL fail and the workflow SHALL report failure

#### Scenario: Workflow bundle build is covered
- **GIVEN** `workflows/package.json` declares `"build": "wfe build"`
- **WHEN** the CI build step runs `pnpm build`
- **THEN** the `workflows` bundle build SHALL be invoked as part of the recursive workspace build
- **AND** a broken demo.ts SHALL cause the step to exit non-zero

## ADDED Requirements

### Requirement: Staging demo workflow upload step

The staging deploy workflow SHALL, after `tofu apply` succeeds, upload the monorepo's `workflows/` bundle to the freshly-deployed staging runtime. The upload SHALL target the URL produced by `tofu output -raw url` from `infrastructure/envs/staging/`. The upload SHALL authenticate as `github:user:stefanhoelzl` using a fine-grained Personal Access Token stored in the repository secret `GH_UPLOAD_TOKEN`, which SHALL be passed to the upload step as the `GITHUB_TOKEN` environment variable. The CLI SHALL auto-detect the target `(owner, repo)` scope from `git remote get-url origin` (yielding `stefanhoelzl/workflow-engine`).

Upload failure SHALL fail the deploy job. The step SHALL NOT use `continue-on-error`.

#### Scenario: Successful deploy uploads demo bundle

- **GIVEN** `tofu apply` has just completed for staging and the runtime is ready
- **WHEN** the upload step runs
- **THEN** `wfe upload --url <staging-url>` SHALL be invoked against `stefanhoelzl/workflow-engine`
- **AND** the `GITHUB_TOKEN` env SHALL be the `GH_UPLOAD_TOKEN` secret value
- **AND** the staging runtime SHALL respond `204 No Content`
- **AND** the deploy job SHALL succeed

#### Scenario: Upload failure fails the deploy

- **GIVEN** the upload step returns non-zero (e.g., 401 Unauthorized, bundle rejected, network error)
- **WHEN** the job evaluates step results
- **THEN** the job SHALL be marked failed
- **AND** no step SHALL use `continue-on-error: true` to mask the failure

#### Scenario: Prod deploy does not upload demo

- **WHEN** the `deploy-prod` workflow runs
- **THEN** it SHALL NOT upload the `workflows/` bundle
- **AND** `GH_UPLOAD_TOKEN` SHALL NOT be referenced by `deploy-prod.yml`

### Requirement: Staging readiness gate before upload

Before invoking the upload step, the staging deploy workflow SHALL poll the freshly-deployed runtime's `/readyz` endpoint until it returns HTTP `200`. The poll SHALL use `curl -fsS --retry 30 --retry-delay 5` (or equivalent), yielding a total upper bound of approximately 2.5 minutes. If `/readyz` does not become ready within the retry budget, the step SHALL fail and the upload step SHALL NOT run.

The readiness target URL SHALL be derived from `tofu output -raw url` from `infrastructure/envs/staging/` (same value used by the upload step).

#### Scenario: Probe succeeds after rollout

- **GIVEN** the Deployment rollout completes within the retry budget
- **WHEN** the readiness step polls `<staging-url>/readyz`
- **THEN** the step SHALL observe a `200` response
- **AND** SHALL exit `0`
- **AND** the upload step SHALL proceed

#### Scenario: Probe timeout fails the deploy

- **GIVEN** `/readyz` never returns `200` within the retry budget
- **WHEN** the readiness step exhausts its retries
- **THEN** the step SHALL exit non-zero
- **AND** the upload step SHALL NOT run
- **AND** the deploy job SHALL fail

### Requirement: Staging demo upload auth secret

The repository SHALL define a secret named `GH_UPLOAD_TOKEN` holding a fine-grained GitHub Personal Access Token whose authenticated identity (`GET /user.login`) is `stefanhoelzl`. The token SHALL NOT require any GitHub-side scopes beyond what `GET /user` permits by default. The secret SHALL be referenced only by `deploy-staging.yml` and SHALL NOT be referenced by `deploy-prod.yml` or any PR-triggered workflow.

`AUTH_ALLOW_STAGING` (the GitHub Actions variable passed as `TF_VAR_auth_allow`) SHALL continue to include `github:user:stefanhoelzl` so that the token's identity is permitted by the staging runtime's ACL.

#### Scenario: Secret referenced by staging deploy only

- **WHEN** inspecting `.github/workflows/*.yml`
- **THEN** exactly one workflow (`deploy-staging.yml`) SHALL reference `secrets.GH_UPLOAD_TOKEN`

#### Scenario: Token identity is permitted by staging ACL

- **GIVEN** the upload step authenticates with `GH_UPLOAD_TOKEN`
- **WHEN** the staging runtime resolves the user via its github auth provider
- **THEN** the user's `login` SHALL be `stefanhoelzl`
- **AND** `isMember(user, owner="stefanhoelzl")` SHALL return true
