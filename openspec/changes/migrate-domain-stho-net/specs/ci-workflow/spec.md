## MODIFIED Requirements

### Requirement: Staging demo workflow upload step

The staging deploy workflow SHALL, after the readiness gate succeeds (see "Staging readiness gate before upload"), upload the monorepo's `workflows/` bundle to the staging runtime at `https://staging.workflow-engine.stho.net`. The upload SHALL authenticate as `github:user:stefanhoelzl` using a fine-grained Personal Access Token stored in the repository secret `GH_UPLOAD_TOKEN`, which SHALL be passed to the upload step as the `GITHUB_TOKEN` environment variable. The CLI SHALL auto-detect the target `(owner, repo)` scope from `git remote get-url origin` (yielding `stefanhoelzl/workflow-engine`).

Upload failure SHALL fail the deploy job. The step SHALL NOT use `continue-on-error`.

#### Scenario: Successful deploy uploads demo bundle

- **GIVEN** the readiness gate confirms the new image is running on staging
- **WHEN** the upload step runs
- **THEN** `wfe upload --url https://staging.workflow-engine.stho.net` SHALL be invoked against `stefanhoelzl/workflow-engine`
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

### Requirement: Staging readiness gate before upload

Before invoking the upload step, the staging deploy workflow SHALL poll `https://staging.workflow-engine.stho.net/readyz` until both of the following hold:

1. The response status is `200`.
2. The response JSON's `version.gitSha` field equals `${{ github.sha }}` — i.e. the new image (not a previously-running one) is the one serving requests.

The poll SHALL retry on a fixed interval (e.g. every 5 seconds) for an upper bound of approximately 5 minutes. If either condition is not met within the budget, the step SHALL fail and the upload step SHALL NOT run.

The workflow SHALL NOT invoke `kubectl`, `upctl`, or any K8s-shaped readiness primitive. The deploy mechanism is `podman-auto-update.timer` (see `infrastructure` capability) which polls the registry every 1 minute; the readiness gate exists to bridge the asynchronous gap between `docker push` and the new container actually running.

#### Scenario: Probe succeeds after auto-update tick

- **GIVEN** the auto-update timer pulls the new image and restarts the unit within the retry budget
- **WHEN** the readiness step polls `/readyz`
- **THEN** the step SHALL observe `200` with `version.gitSha === <github.sha>`
- **AND** SHALL exit `0`
- **AND** the upload step SHALL proceed

#### Scenario: Probe times out fails the deploy

- **GIVEN** the auto-update tick does not happen within the retry budget (e.g. registry rate-limit, image pull failure)
- **WHEN** the readiness step exhausts its retries
- **THEN** the step SHALL exit non-zero
- **AND** the upload step SHALL NOT run
- **AND** the deploy job SHALL fail

#### Scenario: Probe sees old gitSha and continues polling

- **GIVEN** `/readyz` returns `200` with `version.gitSha === <previous-deploy-sha>` (the auto-update tick has not happened yet)
- **WHEN** the readiness step evaluates the response
- **THEN** the step SHALL NOT exit
- **AND** SHALL continue polling until either `gitSha === <github.sha>` or the budget is exhausted
