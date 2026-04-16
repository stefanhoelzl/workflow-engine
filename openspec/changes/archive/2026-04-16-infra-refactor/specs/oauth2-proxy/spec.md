## MODIFIED Requirements

### Requirement: OAuth2-proxy Deployment

The module SHALL create a `kubernetes_deployment_v1` running `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1` with one replica in the namespace specified by `var.namespace`. The pod spec SHALL include `security_context` from the baseline module outputs and `automount_service_account_token = false`. The container spec SHALL include `security_context` with `allow_privilege_escalation = false`, `read_only_root_filesystem = true`, and `capabilities { drop = ["ALL"] }`.

#### Scenario: OAuth2-proxy pod running with security context

- **WHEN** `tofu apply` completes
- **THEN** one oauth2-proxy pod SHALL be running in `var.namespace`
- **AND** the pod SHALL have `runAsNonRoot = true`, `runAsUser = 65532`, and `seccompProfile = RuntimeDefault`
- **AND** the container SHALL have `allowPrivilegeEscalation = false` and `readOnlyRootFilesystem = true`

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
