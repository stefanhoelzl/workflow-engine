### Requirement: oauth2-proxy container runs in the compose stack

oauth2-proxy SHALL run as a Docker container managed by the Pulumi program, using the `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1` image.

#### Scenario: oauth2-proxy container is defined

- **WHEN** `pulumi up` completes
- **THEN** a container named `oauth2-proxy` SHALL be running
- **AND** it SHALL use image `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1`

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

oauth2-proxy credentials (`OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`, `OAUTH2_PROXY_GITHUB_USER`) SHALL be stored as Pulumi encrypted secrets and injected into the container as environment variables by the Pulumi program. They SHALL NOT be read from shell environment variables or `.env` files.

#### Scenario: Secrets are managed by Pulumi

- **WHEN** `pulumi up` is run
- **THEN** oauth2-proxy SHALL receive decrypted secret values as container environment variables

#### Scenario: Missing secrets cause deployment failure

- **WHEN** any required secret is not configured in the Pulumi stack
- **THEN** `pulumi up` SHALL fail with an error identifying the missing secret

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

oauth2-proxy SHALL be configured with `OAUTH2_PROXY_REDIRECT_URL` derived from the Pulumi stack's `domain` and `httpsPort` config values, in the format `https://{domain}:{httpsPort}/oauth2/callback`.

#### Scenario: Callback URL is derived from stack config

- **WHEN** oauth2-proxy starts with dev stack config (`domain=localhost`, `httpsPort=8443`)
- **THEN** it SHALL use `https://localhost:8443/oauth2/callback` as the redirect URL

### Requirement: oauth2-proxy uses standard restart and logging policies

The oauth2-proxy service SHALL use `unless-stopped` restart policy and json-file logging with max-size 10MB and max-file 3.

#### Scenario: Restart and logging policies

- **WHEN** the compose file is parsed
- **THEN** the `oauth2-proxy` service SHALL have restart policy `unless-stopped`
- **AND** logging driver `json-file` with max-size `10m` and max-file `3`

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. This capability owns the UI trust chain:
OAuth2 session management, cookie security, and the GitHub user
allowlist.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, alter the UI trust chain (for example by
changing cookie flags, the allowlist mechanism, or the OAuth2 redirect
surface), or conflict with the rules listed in `/SECURITY.md §4` MUST
update `/SECURITY.md §4` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §4`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §4`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §4`
- **THEN** no update to `/SECURITY.md §4` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
