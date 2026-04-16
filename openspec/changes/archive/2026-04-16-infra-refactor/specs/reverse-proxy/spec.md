## MODIFIED Requirements

### Requirement: Traefik Helm release

The traefik module (`modules/traefik/`, renamed from `modules/routing/`) SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7` in namespace `traefik` (moved from `default`). The release SHALL set explicit pod-level and container-level `securityContext` via Helm values, independent of chart defaults.

The Helm values SHALL include:
- `podSecurityContext`: `runAsNonRoot=true`, `runAsUser=65532`, `runAsGroup=65532`, `fsGroup=65532`, `fsGroupChangePolicy=OnRootMismatch`, `seccompProfile={type: RuntimeDefault}`
- `securityContext` (container-level): `allowPrivilegeEscalation=false`, `readOnlyRootFilesystem=true`, `capabilities={drop: [ALL]}`

The `extraObjects` value SHALL NOT include IngressRoutes or Middlewares (moved to per-instance routes-chart). The `traefik_extra_objects` variable and output are removed.

#### Scenario: Traefik installed in dedicated namespace

- **WHEN** `tofu apply` completes
- **THEN** the Traefik Helm release SHALL be deployed in namespace `traefik`
- **AND** the namespace SHALL be created if it does not exist

#### Scenario: Explicit security context overrides

- **WHEN** the Traefik pod is inspected
- **THEN** the pod SHALL have `runAsNonRoot=true` and `seccompProfile=RuntimeDefault`
- **AND** the main container SHALL have `allowPrivilegeEscalation=false` and `capabilities.drop=[ALL]`

#### Scenario: No IngressRoutes in extraObjects

- **WHEN** the Traefik Helm values are inspected
- **THEN** `extraObjects` SHALL be empty or absent
- **AND** IngressRoutes SHALL be delivered by per-instance routes-chart Helm releases

### Requirement: Traefik inline-response plugin from committed tarball

The plugin tarball SHALL be read from a committed file at `modules/traefik/plugin/plugin-<version>.tar.gz` via `filebase64()` and stored in a Kubernetes ConfigMap. The init container SHALL extract it to the shared `emptyDir` volume.

The init container SHALL have explicit `securityContext`:
- `runAsUser = 65532`
- `runAsNonRoot = true`
- `allowPrivilegeEscalation = false`
- `readOnlyRootFilesystem = true`
- `capabilities = { drop = ["ALL"] }`
- `seccompProfile = { type = "RuntimeDefault" }`

#### Scenario: Init container security context

- **WHEN** the Traefik pod starts
- **THEN** the init container SHALL run as UID 65532 (non-root)
- **AND** the init container SHALL pass PodSecurity `restricted` admission

#### Scenario: Plugin extracted from committed tarball

- **WHEN** the Traefik pod starts
- **THEN** the init container SHALL extract the plugin from the ConfigMap-mounted tarball
- **AND** no runtime fetch from github.com SHALL occur

### Requirement: Traefik workload network allow-rules

The traefik module SHALL create the Traefik NetworkPolicy via the `modules/netpol/` factory. The policy SHALL use cross-namespace selectors for egress to app backends and oauth2-proxy pods in workload namespaces.

The module SHALL accept a `workload_namespaces` variable (list of string) to construct namespace-selector-based egress rules. Egress to ACME solver pods SHALL use a namespace-agnostic selector (`namespace_selector = {}`) since solver pods appear transiently in any namespace with a Certificate resource.

#### Scenario: Traefik reaches app backend across namespaces

- **WHEN** Traefik routes a request to the app's `:8080`
- **THEN** the egress rule with `namespaceSelector` for the app's namespace SHALL permit the connection

#### Scenario: Traefik reaches oauth2-proxy across namespaces

- **WHEN** Traefik makes a forward-auth call to oauth2-proxy on `:4180`
- **THEN** the egress rule with `namespaceSelector` for the oauth2-proxy's namespace SHALL permit the connection

#### Scenario: Traefik reaches ACME solver pods in any namespace

- **WHEN** cert-manager creates a solver pod in namespace `prod` during cert issuance
- **THEN** the egress rule SHALL permit Traefik to reach the solver pod on `:8089`

### Requirement: Error page via variable

The traefik module SHALL accept an `error_page_5xx_html` variable (string) containing the 5xx error page HTML. The `traefik_inline_response` middleware SHALL serve this content. The HTML SHALL no longer be defined as an inline HCL heredoc.

#### Scenario: Error page served from variable

- **WHEN** the Traefik inline-response middleware handles a `/error` request
- **THEN** it SHALL serve the HTML content from `var.error_page_5xx_html`
