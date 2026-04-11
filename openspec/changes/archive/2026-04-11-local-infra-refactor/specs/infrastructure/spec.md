## MODIFIED Requirements

### Requirement: Module wiring

The local root SHALL instantiate five modules: `kubernetes/kind`, `image/local`, `s3/s2`, `workflow-engine`, and `routing`. The kubernetes and helm providers SHALL be configured from the cluster module's credential outputs. The routing module SHALL receive `traefik_extra_objects` from the workflow-engine module and `traefik_helm_sets` from the root config.

#### Scenario: Single apply creates everything

- **WHEN** `tofu apply` is run on a clean state
- **THEN** a kind cluster SHALL be created
- **AND** the app image SHALL be built and loaded
- **AND** S2, app, and oauth2-proxy SHALL be deployed
- **AND** the Traefik Helm release SHALL be deployed with IngressRoute and Middleware CRDs

### Requirement: Non-secret variables in terraform.tfvars

The local root SHALL load non-secret configuration from `terraform.tfvars` (committed): `domain`, `https_port`, `oauth2_github_user`, `s2_access_key`, `s2_secret_key`, `s2_bucket`.

#### Scenario: Default local values

- **WHEN** `terraform.tfvars` is read
- **THEN** `domain` SHALL be `"localhost"`
- **AND** `https_port` SHALL be `8443`
- **AND** `oauth2_github_user` SHALL be `"stefanhoelzl"`

### Requirement: Secret variables in local.secrets.auto.tfvars

The local root SHALL load secrets from `local.secrets.auto.tfvars` (gitignored): `oauth2_client_id`, `oauth2_client_secret`. These SHALL be declared as `sensitive = true` variables.

#### Scenario: Secrets gitignored

- **WHEN** the `.gitignore` is checked
- **THEN** `*.secrets.auto.tfvars` SHALL be listed as ignored

#### Scenario: Missing secrets file fails

- **WHEN** `tofu apply` is run without `local.secrets.auto.tfvars`
- **THEN** it SHALL fail requesting values for `oauth2_client_id` and `oauth2_client_secret`

### Requirement: URL output

The local root SHALL output `url` computed directly from `domain` and `https_port` variables.

#### Scenario: Local URL output

- **WHEN** `tofu apply` completes with `domain = "localhost"` and `https_port = 8443`
- **THEN** the output SHALL include `url = "https://localhost:8443"`

#### Scenario: Standard HTTPS port

- **WHEN** `tofu apply` completes with `domain = "example.com"` and `https_port = 443`
- **THEN** the output SHALL include `url = "https://example.com"`

### Requirement: Lock file committed

The `.terraform.lock.hcl` file SHALL be committed to version control. It SHALL NOT be listed in `.gitignore`.

#### Scenario: Lock file tracked

- **WHEN** `git status` is checked after `tofu init`
- **THEN** `.terraform.lock.hcl` SHALL be tracked (not ignored)

### Requirement: Workflow-engine module composes sub-modules

The `workflow-engine` module SHALL instantiate two sub-modules: `app` and `oauth2-proxy`. It SHALL output `traefik_extra_objects` containing the Middleware and IngressRoute CRD definitions, constructed from `app` and `oauth2-proxy` service names/ports and `var.network`.

#### Scenario: All sub-modules created

- **WHEN** `tofu apply` completes with valid inputs
- **THEN** the app Deployment and Service SHALL exist
- **AND** the oauth2-proxy Deployment and Service SHALL exist

#### Scenario: Extra objects output contains CRDs

- **WHEN** the module is applied
- **THEN** `traefik_extra_objects` SHALL contain an `oauth2-forward-auth` Middleware
- **AND** `traefik_extra_objects` SHALL contain an `oauth2-errors` Middleware
- **AND** `traefik_extra_objects` SHALL contain a `redirect-root` Middleware
- **AND** `traefik_extra_objects` SHALL contain a `workflow-engine` IngressRoute

### Requirement: Traefik Helm release

The routing module SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7`. The Helm release SHALL use `traefik_helm_sets` for environment-specific Helm `set` values and `traefik_extra_objects` for CRD objects deployed via the chart's `extraObjects` feature.

#### Scenario: Traefik installed via Helm with parameterized config

- **WHEN** `tofu apply` completes
- **THEN** Traefik SHALL be running in the cluster
- **AND** the Helm `set` values SHALL match the provided `traefik_helm_sets`
- **AND** the Helm `extraObjects` SHALL contain the provided `traefik_extra_objects`

## REMOVED Requirements

### Requirement: Workflow-engine URL output

**Reason**: URL output moved to root config. The workflow-engine module no longer contains the routing submodule and has no reason to compute or pass through a URL.
**Migration**: Root configs compute `url` directly from `domain` and `https_port` variables.

### Requirement: Routing URL output

**Reason**: The routing module is now a thin Traefik Helm wrapper. It receives `traefik_extra_objects` and `traefik_helm_sets` — it has no knowledge of domain or ports.
**Migration**: Root configs compute `url` directly from their own variables.
