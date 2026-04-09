### Requirement: oauth2-proxy container runs in the compose stack

The docker-compose stack SHALL include an `oauth2-proxy` service using the `quay.io/oauth2-proxy/oauth2-proxy:latest` image.

#### Scenario: oauth2-proxy service is defined

- **WHEN** the compose file is parsed
- **THEN** a service named `oauth2-proxy` SHALL exist
- **AND** it SHALL use image `quay.io/oauth2-proxy/oauth2-proxy:latest`

### Requirement: oauth2-proxy uses GitHub as OAuth provider

oauth2-proxy SHALL be configured with `OAUTH2_PROXY_PROVIDER=github` to authenticate users via GitHub OAuth.

#### Scenario: GitHub provider is configured

- **WHEN** oauth2-proxy starts
- **THEN** it SHALL use the GitHub OAuth provider for authentication

### Requirement: oauth2-proxy listens on port 4180 internally

oauth2-proxy SHALL expose port 4180 to other compose services but SHALL NOT publish it to the host.

#### Scenario: Port is internal only

- **WHEN** the compose stack is running
- **THEN** the `proxy` service SHALL be able to reach `oauth2-proxy:4180`
- **AND** port 4180 SHALL NOT be accessible from the host

### Requirement: Secrets are provided via shell environment variables

oauth2-proxy SHALL receive `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, and `OAUTH2_PROXY_COOKIE_SECRET` from shell environment variables interpolated in docker-compose.yml. These values SHALL NOT be hardcoded or committed to version control.

#### Scenario: Secrets are interpolated from shell environment

- **WHEN** the compose file is parsed
- **THEN** `OAUTH2_PROXY_CLIENT_ID` SHALL reference `${OAUTH2_PROXY_CLIENT_ID}`
- **AND** `OAUTH2_PROXY_CLIENT_SECRET` SHALL reference `${OAUTH2_PROXY_CLIENT_SECRET}`
- **AND** `OAUTH2_PROXY_COOKIE_SECRET` SHALL reference `${OAUTH2_PROXY_COOKIE_SECRET}`

#### Scenario: Missing secrets cause startup failure

- **WHEN** any of the required secret environment variables are not set in the shell
- **THEN** oauth2-proxy SHALL fail to start with an error indicating the missing configuration

### Requirement: Access is restricted to a specific GitHub user

oauth2-proxy SHALL restrict access to the GitHub username specified by the `OAUTH2_PROXY_GITHUB_USER` environment variable.

#### Scenario: Allowed user authenticates

- **WHEN** a user authenticates via GitHub OAuth
- **AND** their GitHub username matches the configured `OAUTH2_PROXY_GITHUB_USER`
- **THEN** oauth2-proxy SHALL grant access

#### Scenario: Disallowed user authenticates

- **WHEN** a user authenticates via GitHub OAuth
- **AND** their GitHub username does not match the configured `OAUTH2_PROXY_GITHUB_USER`
- **THEN** oauth2-proxy SHALL deny access

### Requirement: oauth2-proxy callback URL matches localhost

oauth2-proxy SHALL be configured with `OAUTH2_PROXY_REDIRECT_URL=https://localhost:8443/oauth2/callback` to match the GitHub OAuth App's registered callback URL.

#### Scenario: Callback URL is set

- **WHEN** oauth2-proxy starts
- **THEN** it SHALL use `https://localhost:8443/oauth2/callback` as the redirect URL

### Requirement: oauth2-proxy uses standard restart and logging policies

The oauth2-proxy service SHALL use `unless-stopped` restart policy and json-file logging with max-size 10MB and max-file 3.

#### Scenario: Restart and logging policies

- **WHEN** the compose file is parsed
- **THEN** the `oauth2-proxy` service SHALL have restart policy `unless-stopped`
- **AND** logging driver `json-file` with max-size `10m` and max-file `3`
