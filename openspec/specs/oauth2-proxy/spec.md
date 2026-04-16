### Requirement: OAuth2-proxy Deployment

The module SHALL create a `kubernetes_deployment_v1` running `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1` with one replica in the namespace specified by `var.namespace`. The pod spec SHALL include `security_context` from the baseline module outputs and `automount_service_account_token = false`. The container spec SHALL include `security_context` with `allow_privilege_escalation = false`, `read_only_root_filesystem = true`, and `capabilities { drop = ["ALL"] }`.

#### Scenario: OAuth2-proxy pod running with security context

- **WHEN** `tofu apply` completes
- **THEN** one oauth2-proxy pod SHALL be running in `var.namespace`
- **AND** the pod SHALL have `runAsNonRoot = true`, `runAsUser = 65532`, and `seccompProfile = RuntimeDefault`
- **AND** the container SHALL have `allowPrivilegeEscalation = false` and `readOnlyRootFilesystem = true`

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

### Requirement: OAuth2-proxy environment variables

The oauth2-proxy container SHALL receive environment variables from two local maps iterated via `dynamic "env"` blocks:

1. A plain-value map containing: `OAUTH2_PROXY_PROVIDER`, `OAUTH2_PROXY_GITHUB_USERS`, `OAUTH2_PROXY_REDIRECT_URL`, `OAUTH2_PROXY_WHITELIST_DOMAINS`, `OAUTH2_PROXY_HTTP_ADDRESS`, `OAUTH2_PROXY_REVERSE_PROXY`, `OAUTH2_PROXY_EMAIL_DOMAINS`, `OAUTH2_PROXY_COOKIE_SECURE`, `OAUTH2_PROXY_SET_XAUTHREQUEST`, `OAUTH2_PROXY_UPSTREAMS`, `OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR`.

2. A secret-key-reference map containing: `OAUTH2_PROXY_CLIENT_ID` -> `client-id`, `OAUTH2_PROXY_CLIENT_SECRET` -> `client-secret`, `OAUTH2_PROXY_COOKIE_SECRET` -> `cookie-secret`.

#### Scenario: Sensitive env vars from secret

- **WHEN** the oauth2-proxy container starts
- **THEN** `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, and `OAUTH2_PROXY_COOKIE_SECRET` SHALL be sourced from a Kubernetes Secret via `value_from.secret_key_ref`

#### Scenario: Static env vars from map

- **WHEN** the oauth2-proxy container is inspected
- **THEN** all `OAUTH2_PROXY_*` environment variables SHALL be present with correct values
- **AND** the values SHALL match those produced by the local maps

### Requirement: OAuth2-proxy network allow-rules

The oauth2-proxy NetworkPolicy SHALL be created via the `modules/netpol/` factory with a profile specifying:
- `egress_internet = true`
- `egress_dns = true`
- `ingress_from_pods`: Traefik (cross-namespace from `ns/traefik`) on port 4180
- `ingress_from_cidrs`: node CIDR on port 4180

#### Scenario: Only Traefik reaches oauth2-proxy

- **WHEN** a pod other than Traefik attempts to connect to oauth2-proxy on `:4180`
- **THEN** the NetworkPolicy SHALL cause the connection to be dropped

#### Scenario: Cross-namespace Traefik access

- **WHEN** Traefik in `ns/traefik` makes a forward-auth call to oauth2-proxy in `ns/prod`
- **THEN** the cross-namespace ingress rule SHALL permit the connection

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
