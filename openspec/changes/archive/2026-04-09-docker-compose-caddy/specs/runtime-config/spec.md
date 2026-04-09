## ADDED Requirements

### Requirement: Dockerfile sets WORKFLOW_DIR default

The `infrastructure/Dockerfile` SHALL set `ENV WORKFLOW_DIR=/workflows` so the runtime uses the baked-in workflow bundles by default. This value MAY be overridden at container start time.

#### Scenario: Default WORKFLOW_DIR in image

- **WHEN** the container is started without explicitly setting `WORKFLOW_DIR`
- **THEN** the runtime SHALL use `/workflows` as the workflow directory

#### Scenario: Override WORKFLOW_DIR

- **WHEN** the container is started with `WORKFLOW_DIR=/custom/path`
- **THEN** the runtime SHALL use `/custom/path` instead of the default
