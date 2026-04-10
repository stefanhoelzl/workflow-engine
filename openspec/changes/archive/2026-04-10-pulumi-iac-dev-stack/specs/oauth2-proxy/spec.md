## MODIFIED Requirements

### Requirement: Secrets are provided via shell environment variables

oauth2-proxy credentials (`OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`, `OAUTH2_PROXY_GITHUB_USER`) SHALL be stored as Pulumi encrypted secrets and injected into the container as environment variables by the Pulumi program. They SHALL NOT be read from shell environment variables or `.env` files.

#### Scenario: Secrets are managed by Pulumi

- **WHEN** `pulumi up` is run
- **THEN** oauth2-proxy SHALL receive decrypted secret values as container environment variables

#### Scenario: Missing secrets cause deployment failure

- **WHEN** any required secret is not configured in the Pulumi stack
- **THEN** `pulumi up` SHALL fail with an error identifying the missing secret

### Requirement: oauth2-proxy callback URL matches localhost

oauth2-proxy SHALL be configured with `OAUTH2_PROXY_REDIRECT_URL` derived from the Pulumi stack's `domain` and `httpsPort` config values, in the format `https://{domain}:{httpsPort}/oauth2/callback`.

#### Scenario: Callback URL is derived from stack config

- **WHEN** oauth2-proxy starts with dev stack config (`domain=localhost`, `httpsPort=8443`)
- **THEN** it SHALL use `https://localhost:8443/oauth2/callback` as the redirect URL

### Requirement: oauth2-proxy container runs in the compose stack

oauth2-proxy SHALL run as a Docker container managed by the Pulumi program, using the `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1` image.

#### Scenario: oauth2-proxy container is defined

- **WHEN** `pulumi up` completes
- **THEN** a container named `oauth2-proxy` SHALL be running
- **AND** it SHALL use image `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1`
