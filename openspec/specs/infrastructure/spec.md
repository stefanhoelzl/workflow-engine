<!-- ═══════════════════════════════════════════════════════ -->
<!-- Dev Stack (infrastructure/dev/)                        -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: OpenTofu version constraint

The dev root configuration SHALL require OpenTofu version `>= 1.11`.

#### Scenario: Version check passes

- **WHEN** `tofu apply` is run with OpenTofu 1.11 or later
- **THEN** the version check SHALL pass

#### Scenario: Version check fails

- **WHEN** `tofu apply` is run with OpenTofu older than 1.11
- **THEN** it SHALL fail with an error indicating the minimum required version

### Requirement: Provider version constraints

The dev root SHALL declare required providers with version constraints: `tehcyx/kind ~> 0.11`, `hashicorp/kubernetes ~> 3.0`, `hashicorp/helm ~> 3.1`, `hashicorp/random ~> 3.8`, `hashicorp/null ~> 3.2`.

#### Scenario: Provider versions pinned

- **WHEN** `tofu init` is run
- **THEN** providers SHALL be installed within the declared version constraints
- **AND** exact versions SHALL be recorded in `.terraform.lock.hcl`

### Requirement: Local state backend

The dev root SHALL use `backend "local" {}`. The state file SHALL be gitignored.

#### Scenario: State stored locally

- **WHEN** `tofu apply` completes
- **THEN** state SHALL be written to `terraform.tfstate` in the dev directory

### Requirement: Module wiring

The dev root SHALL instantiate four modules: `kubernetes/kind`, `image/local`, `s3/s2`, and `workflow-engine`. The kubernetes and helm providers SHALL be configured from the cluster module's credential outputs.

#### Scenario: Single apply creates everything

- **WHEN** `tofu apply` is run on a clean state
- **THEN** a kind cluster SHALL be created
- **AND** the app image SHALL be built and loaded
- **AND** S2, app, oauth2-proxy, and Traefik SHALL be deployed
- **AND** IngressRoute CRDs SHALL be created

### Requirement: Non-secret variables in terraform.tfvars

The dev root SHALL load non-secret configuration from `terraform.tfvars` (committed): `domain`, `https_port`, `oauth2_github_user`, `s2_access_key`, `s2_secret_key`, `s2_bucket`.

#### Scenario: Default dev values

- **WHEN** `terraform.tfvars` is read
- **THEN** `domain` SHALL be `"localhost"`
- **AND** `https_port` SHALL be `8443`
- **AND** `oauth2_github_user` SHALL be `"stefanhoelzl"`

### Requirement: Secret variables in dev.secrets.auto.tfvars

The dev root SHALL load secrets from `dev.secrets.auto.tfvars` (gitignored): `oauth2_client_id`, `oauth2_client_secret`. These SHALL be declared as `sensitive = true` variables.

#### Scenario: Secrets gitignored

- **WHEN** the `.gitignore` is checked
- **THEN** `*.secrets.auto.tfvars` SHALL be listed as ignored

#### Scenario: Missing secrets file fails

- **WHEN** `tofu apply` is run without `dev.secrets.auto.tfvars`
- **THEN** it SHALL fail requesting values for `oauth2_client_id` and `oauth2_client_secret`

### Requirement: URL output

The dev root SHALL output the `url` from the `workflow-engine` module.

#### Scenario: Dev URL output

- **WHEN** `tofu apply` completes
- **THEN** the output SHALL include `url = "https://localhost:8443"`

### Requirement: Lock file committed

The `.terraform.lock.hcl` file SHALL be committed to version control. It SHALL NOT be listed in `.gitignore`.

#### Scenario: Lock file tracked

- **WHEN** `git status` is checked after `tofu init`
- **THEN** `.terraform.lock.hcl` SHALL be tracked (not ignored)

### Requirement: Gitignore

The `infrastructure/.gitignore` SHALL ignore `*.secrets.auto.tfvars`, `.terraform/`, `*.tfstate`, and `*.tfstate.backup`.

#### Scenario: Sensitive files ignored

- **WHEN** `git status` is checked
- **THEN** `dev.secrets.auto.tfvars`, `.terraform/`, and `*.tfstate` files SHALL not appear as untracked

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/kubernetes/kind/                               -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: Kind cluster resource

The module SHALL create a `kind_cluster` resource with the provided cluster name. The cluster SHALL have a single control-plane node with an `extraPortMappings` entry mapping the provided `https_port` on the host to port 30443 on the container (matching Traefik's NodePort). Port 443 is avoided because `hostPort: 443` conflicts with the K8s API server's ClusterIP on single-node clusters.

#### Scenario: Cluster creation

- **WHEN** `tofu apply` is run
- **THEN** a kind cluster SHALL be created with the specified name
- **AND** host port `https_port` SHALL be mapped to container port 30443

#### Scenario: Cluster already exists

- **WHEN** `tofu apply` is run and the cluster already exists
- **THEN** no changes SHALL be made to the cluster

### Requirement: Image loading into kind cluster

The module SHALL use a `terraform_data` resource with a `local-exec` provisioner to load the provided `image_name` into the kind cluster via `podman save` piped to `ctr --namespace=k8s.io images import` inside the kind node container.

#### Scenario: Local image loaded into cluster

- **WHEN** `tofu apply` is run with a valid `image_name`
- **THEN** the image SHALL be available inside the kind cluster's containerd runtime

### Requirement: Cluster credential outputs

The module SHALL output `host`, `cluster_ca_certificate`, `client_certificate`, and `client_key` from the kind cluster's credentials. These outputs SHALL be usable to configure the `hashicorp/kubernetes` and `hashicorp/helm` providers.

#### Scenario: Provider configuration from outputs

- **WHEN** the kubernetes provider is configured with the module's outputs
- **THEN** it SHALL successfully connect to the kind cluster's API server

### Requirement: Cluster name output

The module SHALL output the `cluster_name` for use by other modules.

#### Scenario: Cluster name passthrough

- **WHEN** the module is applied
- **THEN** `cluster_name` output SHALL equal the `cluster_name` input

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/image/local/                                   -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: Idempotent image build

The module SHALL use a `terraform_data` resource with a `local-exec` provisioner to build a container image using `podman build`. The build SHALL run on every `tofu apply` (triggered by `timestamp()`). Podman's layer cache ensures cached rebuilds are fast (~7s). A `.dockerignore` SHALL exclude `node_modules`, `dist`, `.git`, and other non-essential directories from the build context.

#### Scenario: Build runs

- **WHEN** `tofu apply` is run
- **THEN** `podman build` SHALL be executed with the provided `dockerfile_path` and `context_dir`
- **AND** the image SHALL be tagged with the provided `image_name`
- **AND** Podman's layer cache SHALL be used for unchanged layers

### Requirement: Image name output

The module SHALL output `image_name` matching the input, so downstream modules can reference the built image.

#### Scenario: Output matches input

- **WHEN** the module is applied with `image_name = "workflow-engine:dev"`
- **THEN** the output `image_name` SHALL be `"workflow-engine:dev"`

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/image/registry/                                -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: Image URL construction

The module SHALL construct a fully qualified container image reference from `registry`, `repository`, and `tag` inputs and output it as `image_name`.

#### Scenario: Standard registry image

- **WHEN** the module is applied with `registry = "ghcr.io"`, `repository = "stefanhoelzl/workflow-engine"`, `tag = "latest"`
- **THEN** `image_name` output SHALL be `"ghcr.io/stefanhoelzl/workflow-engine:latest"`

#### Scenario: Custom tag

- **WHEN** the module is applied with `registry = "ghcr.io"`, `repository = "stefanhoelzl/workflow-engine"`, `tag = "v2026.04.10"`
- **THEN** `image_name` output SHALL be `"ghcr.io/stefanhoelzl/workflow-engine:v2026.04.10"`

### Requirement: No resources created

The module SHALL not create any infrastructure resources. It SHALL only compute and output the `image_name` string.

#### Scenario: Clean plan

- **WHEN** `tofu plan` is run
- **THEN** no resources SHALL be created, modified, or destroyed

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/s3/s2/                                         -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: S2 Deployment

The module SHALL create a `kubernetes_deployment_v1` running `mojatter/s2-server:0.4.1` with one replica. The container SHALL be configured with environment variables `S2_SERVER_USER`, `S2_SERVER_PASSWORD`, `S2_SERVER_BUCKETS`, `S2_SERVER_TYPE=osfs`, and `S2_SERVER_LISTEN=:9000`. The `osfs` backend is required because `memfs` has a bug where `ListObjectsV2` does not return keys containing `/`.

#### Scenario: S2 pod running

- **WHEN** `tofu apply` completes
- **THEN** one S2 pod SHALL be running
- **AND** `S2_SERVER_TYPE` SHALL be `osfs`
- **AND** `S2_SERVER_LISTEN` SHALL be `:9000`
- **AND** `S2_SERVER_USER` SHALL be set from the `access_key` input
- **AND** `S2_SERVER_PASSWORD` SHALL be set from the `secret_key` input
- **AND** `S2_SERVER_BUCKETS` SHALL be set from the `buckets` input

### Requirement: S2 Service

The module SHALL create a `kubernetes_service_v1` exposing the S2 deployment on port 9000.

#### Scenario: Service resolves to S2 pod

- **WHEN** a K8s pod sends a request to `http://s2:9000`
- **THEN** the request SHALL be routed to the S2 container on port 9000

### Requirement: S2 health probe

The S2 deployment SHALL have a liveness probe configured as `GET /healthz` on port 9000 with a 5-second period.

#### Scenario: S2 health check

- **WHEN** the S2 container is healthy
- **THEN** `GET /healthz` on port 9000 SHALL return a success status

### Requirement: S3 output contract

The module SHALL output `endpoint`, `bucket`, `access_key`, `secret_key` (sensitive), and `region`. The `endpoint` SHALL be the internal K8s service URL (`http://<service_name>:9000`). The `region` SHALL be `"local"`.

#### Scenario: Outputs match contract

- **WHEN** the module is applied with `access_key = "minioadmin"`, `secret_key = "minioadmin"`, `buckets = "workflow-engine"`
- **THEN** `endpoint` SHALL be `"http://s2:9000"`
- **AND** `bucket` SHALL be `"workflow-engine"`
- **AND** `access_key` SHALL be `"minioadmin"`
- **AND** `secret_key` SHALL be `"minioadmin"`
- **AND** `region` SHALL be `"local"`

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/workflow-engine/                                -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: Workflow-engine module composes sub-modules

The `workflow-engine` module SHALL instantiate three sub-modules: `app`, `oauth2-proxy`, and `routing`. It SHALL pass through inputs to each sub-module and wire internal outputs (service names and ports) from `app` and `oauth2-proxy` into the `routing` module.

#### Scenario: All sub-modules created

- **WHEN** `tofu apply` completes with valid inputs
- **THEN** the app Deployment and Service SHALL exist
- **AND** the oauth2-proxy Deployment and Service SHALL exist
- **AND** the Traefik Helm release and IngressRoute CRDs SHALL exist

### Requirement: Workflow-engine URL output

The module SHALL output a `url` string constructed by the routing sub-module.

#### Scenario: Non-standard port

- **WHEN** the module is applied with `domain = "localhost"` and `https_port = 8443`
- **THEN** `url` SHALL be `"https://localhost:8443"`

#### Scenario: Standard HTTPS port

- **WHEN** the module is applied with `domain = "example.com"` and `https_port = 443`
- **THEN** `url` SHALL be `"https://example.com"`

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/workflow-engine/modules/app/                    -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: App Deployment

The module SHALL create a `kubernetes_deployment_v1` running the provided `image` with one replica. The container SHALL listen on port 8080.

#### Scenario: App pod running

- **WHEN** `tofu apply` completes
- **THEN** one app pod SHALL be running with the specified image

### Requirement: App S3 environment variables

The app container SHALL receive S3 configuration via environment variables sourced from a Kubernetes Secret: `PERSISTENCE_S3_BUCKET`, `PERSISTENCE_S3_ACCESS_KEY_ID`, `PERSISTENCE_S3_SECRET_ACCESS_KEY`, `PERSISTENCE_S3_ENDPOINT`, and `PERSISTENCE_S3_REGION`.

#### Scenario: S3 env vars set from secret

- **WHEN** the app container starts
- **THEN** `PERSISTENCE_S3_BUCKET` SHALL be set from the secret
- **AND** `PERSISTENCE_S3_ACCESS_KEY_ID` SHALL be set from the secret
- **AND** `PERSISTENCE_S3_SECRET_ACCESS_KEY` SHALL be set from the secret
- **AND** `PERSISTENCE_S3_ENDPOINT` SHALL be set from the secret
- **AND** `PERSISTENCE_S3_REGION` SHALL be set from the secret

### Requirement: App S3 Secret

The module SHALL create a `kubernetes_secret_v1` containing the S3 credentials (`s3_access_key`, `s3_secret_key`, `s3_endpoint`, `s3_bucket`, `s3_region`).

#### Scenario: Secret created

- **WHEN** `tofu apply` completes
- **THEN** a Kubernetes Secret SHALL exist containing the S3 configuration values

### Requirement: App health probes

The app deployment SHALL have a liveness probe (`GET /healthz` on port 8080, 5-second period, 5-second initial delay) and a readiness probe (`GET /healthz` on port 8080, 5-second period).

#### Scenario: Liveness probe

- **WHEN** the app container is running
- **THEN** Kubernetes SHALL probe `GET /healthz` on port 8080 every 5 seconds with a 5-second initial delay

#### Scenario: Readiness probe

- **WHEN** the app container is running
- **THEN** Kubernetes SHALL probe `GET /healthz` on port 8080 every 5 seconds to determine readiness

### Requirement: App Service

The module SHALL create a `kubernetes_service_v1` exposing the app on port 8080. The module SHALL output `service_name` and `service_port`.

#### Scenario: Service routes to app

- **WHEN** a request is sent to the app service on port 8080
- **THEN** it SHALL be routed to the app container on port 8080

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/workflow-engine/modules/oauth2-proxy/           -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: OAuth2-proxy Deployment

The module SHALL create a `kubernetes_deployment_v1` running `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1` with one replica.

#### Scenario: OAuth2-proxy pod running

- **WHEN** `tofu apply` completes
- **THEN** one oauth2-proxy pod SHALL be running

### Requirement: OAuth2-proxy environment variables

The oauth2-proxy container SHALL receive sensitive environment variables from a Kubernetes Secret: `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`. The following SHALL be set directly: `OAUTH2_PROXY_PROVIDER=github`, `OAUTH2_PROXY_GITHUB_USER`, `OAUTH2_PROXY_REDIRECT_URL` (derived from `domain` and `https_port`), `OAUTH2_PROXY_WHITELIST_DOMAINS` (derived from `domain` and `https_port`, enables `{url}` redirect), `OAUTH2_PROXY_LOGOUT_REDIRECT_URL=/oauth2/sign_in` (prevents sign-out loop), `OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180`, `OAUTH2_PROXY_REVERSE_PROXY=true`, `OAUTH2_PROXY_EMAIL_DOMAINS=*`, `OAUTH2_PROXY_COOKIE_SECURE=true`, `OAUTH2_PROXY_SET_XAUTHREQUEST=true`, `OAUTH2_PROXY_UPSTREAMS=static://202`.

#### Scenario: Sensitive env vars from secret

- **WHEN** the oauth2-proxy container starts
- **THEN** `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, and `OAUTH2_PROXY_COOKIE_SECRET` SHALL be sourced from a Kubernetes Secret

#### Scenario: Static env vars

- **WHEN** the oauth2-proxy container is inspected
- **THEN** `OAUTH2_PROXY_PROVIDER` SHALL be `github`
- **AND** `OAUTH2_PROXY_HTTP_ADDRESS` SHALL be `0.0.0.0:4180`
- **AND** `OAUTH2_PROXY_REVERSE_PROXY` SHALL be `true`
- **AND** `OAUTH2_PROXY_EMAIL_DOMAINS` SHALL be `*`
- **AND** `OAUTH2_PROXY_COOKIE_SECURE` SHALL be `true`
- **AND** `OAUTH2_PROXY_SET_XAUTHREQUEST` SHALL be `true`
- **AND** `OAUTH2_PROXY_UPSTREAMS` SHALL be `static://202`
- **AND** `OAUTH2_PROXY_WHITELIST_DOMAINS` SHALL be derived from `domain` and `https_port`
- **AND** `OAUTH2_PROXY_LOGOUT_REDIRECT_URL` SHALL be `/oauth2/sign_in`

### Requirement: Cookie secret generation

The module SHALL internally generate a 32-byte random cookie secret using `random_password`. This secret SHALL NOT be an input to the module.

#### Scenario: Cookie secret generated

- **WHEN** `tofu apply` completes
- **THEN** a 32-character random password SHALL be generated
- **AND** it SHALL be stored in the Kubernetes Secret as `OAUTH2_PROXY_COOKIE_SECRET`

### Requirement: OAuth2-proxy Secret

The module SHALL create a `kubernetes_secret_v1` containing `client_id`, `client_secret`, and the generated `cookie_secret`.

#### Scenario: Secret contains credentials

- **WHEN** `tofu apply` completes
- **THEN** a Kubernetes Secret SHALL exist with the OAuth2 credentials

### Requirement: OAuth2-proxy health probe

The oauth2-proxy deployment SHALL have a liveness probe configured as `GET /ping` on port 4180 with a 5-second period.

#### Scenario: Liveness probe

- **WHEN** the oauth2-proxy container is running
- **THEN** Kubernetes SHALL probe `GET /ping` on port 4180 every 5 seconds

### Requirement: OAuth2-proxy Service

The module SHALL create a `kubernetes_service_v1` exposing oauth2-proxy on port 4180. The module SHALL output `service_name` and `service_port`.

#### Scenario: Service routes to oauth2-proxy

- **WHEN** a request is sent to the oauth2-proxy service on port 4180
- **THEN** it SHALL be routed to the oauth2-proxy container on port 4180

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/workflow-engine/modules/routing/                -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: Traefik Helm release

The module SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7`. The Helm release SHALL configure Traefik with a `NodePort` service on port 30443 for the websecure entrypoint. The IngressRoute, ForwardAuth Middleware, and Errors Middleware SHALL be deployed via the Helm chart's `extraObjects` feature (not as separate `kubernetes_manifest` resources) to avoid CRD timing issues during first apply.

#### Scenario: Traefik installed via Helm

- **WHEN** `tofu apply` completes
- **THEN** Traefik SHALL be running in the cluster
- **AND** the Traefik CRDs (IngressRoute, Middleware) SHALL be registered
- **AND** the IngressRoute and Middleware objects SHALL be deployed as part of the Helm release

### Requirement: ForwardAuth Middleware

The Helm release `extraObjects` SHALL include a Traefik `Middleware` CRD of type `forwardAuth`. The middleware SHALL forward auth requests to `http://<oauth2_service>:<oauth2_port>/oauth2/auth` with `trustForwardHeader: true` and `authResponseHeaders` including `X-Auth-Request-User`, `X-Auth-Request-Email`, and `X-Auth-Request-Redirect`.

#### Scenario: ForwardAuth middleware created

- **WHEN** `tofu apply` completes
- **THEN** a Traefik Middleware of type `forwardAuth` SHALL exist
- **AND** its address SHALL point to the oauth2-proxy service's `/oauth2/auth` endpoint

### Requirement: Errors Middleware for OAuth2 redirect

The Helm release `extraObjects` SHALL include a Traefik `Middleware` CRD of type `errors`. The middleware SHALL intercept 401-403 responses and proxy them to `oauth2-proxy`'s `/oauth2/sign_in?rd={url}` endpoint, rendering the sign-in page for unauthenticated users.

#### Scenario: Unauthenticated user sees sign-in page

- **WHEN** an unauthenticated request hits a protected route
- **THEN** the ForwardAuth middleware SHALL return 401
- **AND** the Errors middleware SHALL intercept the 401
- **AND** the user SHALL see the oauth2-proxy sign-in page

### Requirement: Root redirect

The Helm release `extraObjects` SHALL include a Traefik `Middleware` CRD of type `redirectRegex` that redirects requests matching the root path (`/`) to `/trigger`.

#### Scenario: Root path redirects to trigger

- **WHEN** a request matches `Path('/')`
- **THEN** the user SHALL be redirected to `/trigger` with a 302 status

### Requirement: IngressRoute for routing

The Helm release `extraObjects` SHALL include a Traefik `IngressRoute` CRD on the `websecure` entrypoint. The route rules SHALL be:

- `Path('/')` redirects to `/trigger` (via redirect-root middleware)
- `PathPrefix('/oauth2')` routes to the oauth2-proxy service (no middleware)
- `PathPrefix('/webhooks')` routes to the app service (no middleware)
- `PathPrefix('/dashboard')` routes to the app service (with Errors + ForwardAuth middleware)
- `PathPrefix('/trigger')` routes to the app service (with Errors + ForwardAuth middleware)

#### Scenario: OAuth2 routes

- **WHEN** a request matches `PathPrefix('/oauth2')`
- **THEN** it SHALL be routed to `oauth2_service:oauth2_port` without authentication middleware

#### Scenario: Webhook routes

- **WHEN** a request matches `PathPrefix('/webhooks')`
- **THEN** it SHALL be routed to `app_service:app_port` without authentication middleware

#### Scenario: Dashboard routes with auth

- **WHEN** a request matches `PathPrefix('/dashboard')`
- **THEN** the ForwardAuth middleware SHALL verify the request via oauth2-proxy
- **AND** unauthenticated requests SHALL see the oauth2-proxy sign-in page
- **AND** authenticated requests SHALL be routed to `app_service:app_port`

#### Scenario: Trigger routes with auth

- **WHEN** a request matches `PathPrefix('/trigger')`
- **THEN** the ForwardAuth middleware SHALL verify the request via oauth2-proxy
- **AND** unauthenticated requests SHALL see the oauth2-proxy sign-in page
- **AND** authenticated requests SHALL be routed to `app_service:app_port`

### Requirement: Routing URL output

The module SHALL output a `url` string. When `https_port` is 443, the URL SHALL be `https://<domain>`. Otherwise, it SHALL be `https://<domain>:<https_port>`.

#### Scenario: Non-standard port

- **WHEN** `domain = "localhost"` and `https_port = 8443`
- **THEN** `url` SHALL be `"https://localhost:8443"`

#### Scenario: Standard HTTPS port

- **WHEN** `domain = "example.com"` and `https_port = 443`
- **THEN** `url` SHALL be `"https://example.com"`
