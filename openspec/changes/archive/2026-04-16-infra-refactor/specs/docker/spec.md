## MODIFIED Requirements

### Requirement: Dockerfile USER directive

The Dockerfile SHALL use `USER 65532` (numeric UID) instead of `USER nonroot`. This is the same UID (distroless "nonroot" user) but in numeric form, which PodSecurity admission can validate statically without inspecting the image's `/etc/passwd`.

#### Scenario: Numeric UID in Dockerfile

- **WHEN** the Dockerfile is inspected
- **THEN** the `USER` directive SHALL be `65532`

#### Scenario: Container runs as non-root

- **WHEN** the container starts
- **THEN** the process SHALL run as UID 65532
- **AND** the behavior SHALL be identical to the previous `USER nonroot` directive
