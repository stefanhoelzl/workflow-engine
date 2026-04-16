## MODIFIED Requirements

### Requirement: Module wiring

The local root (`envs/local/local.tf`) SHALL instantiate five modules: `kubernetes/kind`, `image/build`, `object-storage/s2`, `baseline`, `cert-manager`, `traefik`, and `app-instance` (via `for_each`). The kubernetes and helm providers SHALL be configured from the cluster module's credential outputs. The traefik module SHALL receive service configuration and error page HTML. The app-instance module SHALL receive baseline, traefik readiness, and per-instance config from the `for_each` map.

#### Scenario: Single apply creates everything

- **WHEN** `tofu apply` is run on a clean state
- **THEN** a kind cluster SHALL be created
- **AND** the app image SHALL be built and loaded
- **AND** workload namespaces SHALL be created with PSA labels
- **AND** S2, app, and oauth2-proxy SHALL be deployed in their respective namespaces
- **AND** the Traefik Helm release SHALL be deployed in `ns/traefik`
- **AND** per-instance routes Helm releases SHALL be deployed
- **AND** cert-manager SHALL be deployed with selfsigned CA

### Requirement: Production composition root

`envs/upcloud/cluster/upcloud.tf` SHALL wire modules: `kubernetes/upcloud`, `baseline`, `cert-manager`, `traefik`, `app-instance` (via `for_each`), and `dns/dynu`. It SHALL use an S3 backend (state bucket, key `upcloud`, credentials from environment variables). The kubernetes and helm providers SHALL be configured from the cluster module's ephemeral credential outputs. App instances SHALL be defined in a `local.instances` map.

#### Scenario: Single apply deploys production stack

- **WHEN** `tofu apply` is run in `envs/upcloud/cluster/` with the persistence project already applied
- **THEN** a K8s cluster SHALL be created
- **AND** workload namespaces SHALL be created with PSA labels
- **AND** the app and oauth2-proxy SHALL be deployed in namespace `prod`
- **AND** Traefik SHALL be deployed in namespace `traefik` with LoadBalancer service
- **AND** cert-manager SHALL be deployed with ACME HTTP-01
- **AND** the Dynu DNS CNAME record SHALL be created pointing at the LB hostname

#### Scenario: Adding staging instance

- **WHEN** a new entry is added to `local.instances` map with key `staging`
- **THEN** `tofu apply` SHALL create namespace `staging` with PSA label
- **AND** a new app-instance SHALL be deployed in `staging` with its own oauth2-proxy, routes, and NetworkPolicies

### Requirement: Multi-instance support via for_each

The app-instance module SHALL be called with `for_each` over a map of instance configurations. Each instance SHALL receive its own `namespace`, `instance_name`, `network` (domain, port), `oauth2` credentials, `s3` configuration, and `tls` settings.

#### Scenario: Single instance (local/current prod)

- **WHEN** `for_each` is set to `{ default = {...} }` (local) or `{ prod = {...} }` (production)
- **THEN** one app-instance SHALL be deployed in the named namespace

#### Scenario: Multiple instances

- **WHEN** `for_each` is set to `{ prod = {...}, staging = {...} }`
- **THEN** two independent app-instances SHALL be deployed in namespaces `prod` and `staging`
- **AND** each SHALL have its own Deployment, Service, Secret, NetworkPolicy, oauth2-proxy, and routes Helm release

### Requirement: Namespace isolation

Workloads SHALL be deployed in dedicated namespaces, not `default`:
- App instances: namespace = instance name (e.g., `prod`, `staging`, `workflow-engine` for local)
- Traefik: namespace `traefik`
- cert-manager: namespace `cert-manager` (unchanged)
- S2 (local only): namespace `default`

#### Scenario: Default namespace is empty in production

- **WHEN** `tofu apply` completes in production
- **THEN** no application workloads SHALL be running in the `default` namespace

#### Scenario: Traefik in dedicated namespace

- **WHEN** `tofu apply` completes
- **THEN** the Traefik Helm release SHALL be deployed in namespace `traefik`

### Requirement: Standardized labels

All workloads SHALL use `app.kubernetes.io/name` (service identity) and `app.kubernetes.io/instance` (instance identity) labels. These labels SHALL be used in Deployment selectors, Service selectors, and NetworkPolicy pod selectors.

#### Scenario: Label consistency

- **WHEN** the workflow-engine Deployment is inspected in namespace `prod`
- **THEN** its labels SHALL include `app.kubernetes.io/name=workflow-engine` and `app.kubernetes.io/instance=prod`

### Requirement: Traefik inline-response plugin source committed to repo

The Traefik inline-response plugin tarball SHALL be committed to the repository at `modules/traefik/plugin/plugin-<version>.tar.gz`. The ConfigMap SHALL read the tarball via `filebase64()`. The plugin version SHALL be declared in a `locals` block.

Version bumps SHALL be performed by downloading the new tarball, committing it, and updating `local.plugin_version`. No runtime fetch, no `data.external`, no `.plugin-cache/` directory, no `terraform_data` with `ignore_changes`.

#### Scenario: Plugin loaded from committed file

- **WHEN** `tofu apply` runs
- **THEN** the ConfigMap `binary_data` SHALL contain the tarball read via `filebase64()` from the committed file
- **AND** no runtime HTTPS request SHALL be made for plugin loading
- **AND** no bash, curl, or base64 commands SHALL be executed

#### Scenario: Plugin version bump

- **WHEN** `local.plugin_version` is updated and a new tarball file is committed
- **THEN** `tofu plan` SHALL show a ConfigMap update with the new binary content
- **AND** the old tarball file SHALL be removed from the repository

#### Scenario: Works on any platform

- **WHEN** `tofu apply` runs on Linux, macOS, or Windows
- **THEN** `filebase64()` SHALL read the committed tarball without platform-specific dependencies

### Requirement: Routes delivered via per-instance Helm chart

Each app-instance SHALL deliver its IngressRoutes and Middlewares via a `helm_release` pointing at a co-located local chart (`modules/app-instance/routes-chart/`). The chart SHALL template route definitions using `{{ .Values }}` for domain, service names, ports, and TLS configuration.

#### Scenario: Route edits do not restart Traefik

- **WHEN** an IngressRoute path or middleware is modified in the routes-chart
- **THEN** `tofu apply` SHALL update the routes `helm_release` only
- **AND** the Traefik `helm_release` SHALL show no changes

#### Scenario: Multiple instances have independent routes

- **WHEN** two app-instances are deployed (prod and staging)
- **THEN** each SHALL have its own routes `helm_release` with distinct name and values
- **AND** modifying staging routes SHALL not affect the prod routes release

#### Scenario: Single apply from scratch works

- **WHEN** `tofu apply` is run on a clean state creating the cluster, Traefik, and app-instances
- **THEN** the routes Helm chart SHALL install successfully after Traefik registers its CRDs
- **AND** no plan-time CRD access SHALL be required

### Requirement: DNS module extraction

The Dynu DNS CNAME record management SHALL be extracted to `modules/dns/dynu/`. The module SHALL accept `domain`, `target_hostname`, and `api_key` inputs and create the restapi provider, domain data lookup, and CNAME record resource.

#### Scenario: DNS module creates CNAME record

- **WHEN** the dns/dynu module is applied with a valid domain and target hostname
- **THEN** a CNAME record SHALL be created pointing the domain at the target hostname

#### Scenario: Provider swap readiness

- **WHEN** a new DNS provider is needed (e.g., Scaleway DNS)
- **THEN** a new `modules/dns/<provider>/` module can be created with the same interface
- **AND** the env root swaps the module source without other changes

### Requirement: Error page template as file

The 5xx error page HTML SHALL be stored as `infrastructure/templates/error-5xx.html` (not as an inline HCL heredoc). The traefik module SHALL accept it as a `error_page_5xx_html` variable. Env roots SHALL read it via `file()`.

#### Scenario: Template read from file

- **WHEN** `tofu apply` runs
- **THEN** the Traefik inline-response middleware SHALL serve the HTML content read from `templates/error-5xx.html`

### Requirement: Staging bucket in cluster state

When a staging app-instance is deployed in the production cluster, its S3 bucket SHALL be created in `envs/upcloud/cluster/` (not `envs/upcloud/persistence/`). The bucket SHALL be destroyed when the staging instance is removed.

#### Scenario: Staging bucket lifecycle

- **WHEN** the staging entry is removed from `local.instances`
- **THEN** `tofu apply` SHALL destroy the staging S3 bucket and its contents

#### Scenario: Prod bucket unaffected

- **WHEN** the staging instance is destroyed
- **THEN** the production S3 bucket in `envs/upcloud/persistence/` SHALL remain intact

### Requirement: Deployment depends on NetworkPolicy

Every `kubernetes_deployment_v1` SHALL declare `depends_on` on its corresponding NetworkPolicy (via the netpol factory module) and on the baseline module. This ensures the NP allow-rules are in place before the pod starts, preventing DNS-blocked-at-boot races on CNIs that enforce NetworkPolicy asynchronously.

#### Scenario: NP exists before pod starts

- **WHEN** `tofu apply` runs on a clean state
- **THEN** the app's NetworkPolicy SHALL be created before the app Deployment
- **AND** the baseline default-deny NetworkPolicy SHALL be created before any workload Deployment

### Requirement: oauth2-proxy env vars via dynamic maps

The oauth2-proxy container's environment variables SHALL be defined using `dynamic "env"` blocks iterating over two local maps: one for plain values and one for secret key references. This replaces ~15 individual `env {}` blocks.

#### Scenario: All env vars set from maps

- **WHEN** the oauth2-proxy Deployment is inspected
- **THEN** all `OAUTH2_PROXY_*` environment variables SHALL be present with correct values
- **AND** `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, and `OAUTH2_PROXY_COOKIE_SECRET` SHALL be sourced from the Kubernetes Secret

### Requirement: Persistence project path

The persistence project SHALL live at `infrastructure/envs/upcloud/persistence/` (moved from `infrastructure/upcloud/persistence/`). Its S3 backend key SHALL remain `persistence`. Its state and behavior SHALL be unchanged.

#### Scenario: State continuity after path move

- **WHEN** `tofu init` is run in the new path
- **THEN** it SHALL pull the same state from the S3 backend (key `persistence`)
- **AND** `tofu plan` SHALL show no changes

## REMOVED Requirements

### Requirement: Image URL construction

**Reason**: The `modules/image/registry/` module (19 lines, creates no resources, only computes a string) is removed. The image reference is inlined in the env root as a string interpolation.

**Migration**: Replace `module.image.image_name` with `"ghcr.io/stefanhoelzl/workflow-engine:${var.image_tag}"` in `envs/upcloud/cluster/upcloud.tf`.

### Requirement: No resources created

**Reason**: Removed along with the `modules/image/registry/` module.

**Migration**: N/A — the module created no resources.

### Requirement: Traefik inline-response plugin source fetched and vendored at apply time

**Reason**: Replaced by committed plugin tarball (see modified requirement "Traefik inline-response plugin source committed to repo"). The `data.external` bash+curl fetch pipeline, `.plugin-cache/` directory, `terraform_data` with `ignore_changes`, and state-captured bytes pattern are all removed.

**Migration**: Download the tarball once, commit to `modules/traefik/plugin/plugin-v0.1.2.tar.gz`, use `filebase64()`.

### Requirement: Namespace default-deny NetworkPolicy

**Reason**: Moved from the workflow-engine umbrella module to `modules/baseline/`. The requirement is now part of the `pod-security-baseline` capability spec. Behavior is unchanged.

**Migration**: The default-deny NP is now created per-namespace by the baseline module, not once in the workflow-engine module.

### Requirement: Workflow-engine module composes sub-modules

**Reason**: The `modules/workflow-engine/` module with nested `modules/app/` and `modules/oauth2-proxy/` sub-modules is replaced by the flattened `modules/app-instance/` module. Sub-modules are eliminated; resources live directly in `app-instance/*.tf` files.

**Migration**: `module.workflow_engine` becomes `module.app_instance["<instance_name>"]`.

### Requirement: Workflow-engine module threads oauth2 allow-list to app

**Reason**: The flattened app-instance module no longer has sub-modules. The `github_users` value is set directly on the app container's `GITHUB_USER` env var within the same module.

**Migration**: Threading is implicit — same module, no sub-module boundary.
