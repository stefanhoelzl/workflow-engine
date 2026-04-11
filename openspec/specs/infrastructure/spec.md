<!-- ═══════════════════════════════════════════════════════ -->
<!-- Local Stack (infrastructure/local/)                    -->
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

The local root SHALL instantiate five modules: `kubernetes/kind`, `image/local`, `s3/s2`, `workflow-engine`, and `routing`. The kubernetes and helm providers SHALL be configured from the cluster module's credential outputs. The routing module SHALL receive `traefik_extra_objects` from the workflow-engine module and `traefik_helm_sets` from the root config.

#### Scenario: Single apply creates everything

- **WHEN** `tofu apply` is run on a clean state
- **THEN** a kind cluster SHALL be created
- **AND** the app image SHALL be built and loaded
- **AND** S2, app, and oauth2-proxy SHALL be deployed
- **AND** the Traefik Helm release SHALL be deployed with IngressRoute and Middleware CRDs

### Requirement: Non-secret variables in terraform.tfvars

The local root SHALL load non-secret configuration from `terraform.tfvars` (committed): `domain`, `https_port`, `oauth2_github_users`, `s2_access_key`, `s2_secret_key`, `s2_bucket`. The `oauth2_github_users` variable SHALL be a string containing a comma-separated list of GitHub logins and SHALL feed both the oauth2-proxy allow-list and the app's `GITHUB_USER` environment variable so a single source of truth governs who may access the workflow engine.

#### Scenario: Default local values

- **WHEN** `terraform.tfvars` is read
- **THEN** `domain` SHALL be `"localhost"`
- **AND** `https_port` SHALL be `8443`
- **AND** `oauth2_github_users` SHALL be a comma-separated list of allowed GitHub logins (default `"stefanhoelzl"`)

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

### Requirement: Gitignore

The `infrastructure/.gitignore` SHALL ignore `*.secrets.auto.tfvars`, `.terraform/`, `*.tfstate`, and `*.tfstate.backup`.

#### Scenario: Sensitive files ignored

- **WHEN** `git status` is checked
- **THEN** `local.secrets.auto.tfvars`, `.terraform/`, and `*.tfstate` files SHALL not appear as untracked

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

### Requirement: Workflow-engine module threads oauth2 allow-list to app

The `modules/workflow-engine` module SHALL pass `var.oauth2.github_users` into the `app` module as its `github_users` input. The app module SHALL NOT receive any other field from the `oauth2` variable.

#### Scenario: Allow-list propagation

- **WHEN** `tofu apply` runs with `oauth2.github_users = "alice,bob"`
- **THEN** the rendered oauth2-proxy deployment SHALL have `OAUTH2_PROXY_GITHUB_USERS=alice,bob`
- **AND** the rendered app deployment SHALL have `GITHUB_USER=alice,bob`

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

### Requirement: App module accepts github_users input

The `modules/workflow-engine/modules/app` module SHALL declare a `github_users` input variable (type `string`). The module SHALL inject the value as the `GITHUB_USER` environment variable on the app container using a plain `env { name = "GITHUB_USER" value = var.github_users }` block (i.e., not from a secret), so the allow-list is visible in pod specs and Kubernetes events for auditability.

#### Scenario: github_users threaded to pod env

- **WHEN** the `app` module is instantiated with `github_users = "alice,bob"`
- **THEN** the rendered `kubernetes_deployment_v1.app` SHALL contain a container `env` entry with `name = "GITHUB_USER"` and `value = "alice,bob"`

#### Scenario: github_users empty string

- **WHEN** the `app` module is instantiated with `github_users = ""`
- **THEN** the rendered deployment SHALL still include the `GITHUB_USER` env var with an empty string value
- **AND** the app SHALL resolve `githubAuth.mode` to `restricted` with a single empty-string user, which cannot match any GitHub login (effectively blocks all requests)

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
<!-- modules/routing/                                       -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: Traefik Helm release

The routing module SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7`. The Helm release SHALL use `traefik_helm_sets` for environment-specific Helm `set` values and `traefik_extra_objects` for CRD objects deployed via the chart's `extraObjects` feature.

#### Scenario: Traefik installed via Helm with parameterized config

- **WHEN** `tofu apply` completes
- **THEN** Traefik SHALL be running in the cluster
- **AND** the Helm `set` values SHALL match the provided `traefik_helm_sets`
- **AND** the Helm `extraObjects` SHALL contain the provided `traefik_extra_objects`

#### Scenario: Web entrypoint enabled internally

- **WHEN** the Traefik pod is running
- **THEN** the web entrypoint SHALL listen on port 80 inside the pod
- **AND** the Traefik K8s Service SHALL include port 80
- **AND** no NodePort SHALL be mapped to port 80

#### Scenario: Plugin installed

- **WHEN** the Traefik pod starts
- **THEN** the `traefik_inline_response` plugin SHALL be loaded and available for middleware configuration

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

The Helm release `extraObjects` SHALL include Traefik `IngressRoute` CRDs on the `websecure` entrypoint organized into four categories:

**Auth whitelist** (oauth2-proxy protected):
- `PathPrefix('/dashboard')` routes to app service (with oauth2-errors + oauth2-forward-auth + not-found + server-error middleware)
- `PathPrefix('/trigger')` routes to app service (with oauth2-errors + oauth2-forward-auth + not-found + server-error middleware)

**No-auth whitelist** (public):
- `Path('/')` redirects to `/trigger` (via redirect-root middleware, no error middleware)
- `PathPrefix('/oauth2')` routes to oauth2-proxy service (no middleware)
- `PathPrefix('/static')` routes to app service (no error middleware)
- `PathPrefix('/webhooks')` routes to app service (with server-error middleware)
- `Path('/livez')` routes to app service (no middleware)

**App-auth** (app validates tokens internally):
- `PathPrefix('/api')` routes to app service (with server-error middleware)

**Catch-all** (deny by default):
- `PathPrefix('/')` with low priority routes to app service (with not-found middleware)

#### Scenario: OAuth2 routes

- **WHEN** a request matches `PathPrefix('/oauth2')`
- **THEN** it SHALL be routed to `oauth2_service:oauth2_port` without authentication or error middleware

#### Scenario: Webhook routes

- **WHEN** a request matches `PathPrefix('/webhooks')`
- **THEN** it SHALL be routed to `app_service:app_port` without authentication middleware
- **AND** with the server-error middleware

#### Scenario: Static asset routes

- **WHEN** a request matches `PathPrefix('/static')`
- **THEN** it SHALL be routed to `app_service:app_port` without any error or authentication middleware

#### Scenario: Livez route

- **WHEN** a request matches `Path('/livez')`
- **THEN** it SHALL be routed to `app_service:app_port` without any middleware

#### Scenario: API routes

- **WHEN** a request matches `PathPrefix('/api')`
- **THEN** it SHALL be routed to `app_service:app_port` without oauth2 middleware
- **AND** with the server-error middleware

#### Scenario: Dashboard routes with auth

- **WHEN** a request matches `PathPrefix('/dashboard')`
- **THEN** the ForwardAuth middleware SHALL verify the request via oauth2-proxy
- **AND** unauthenticated requests SHALL see the oauth2-proxy sign-in page
- **AND** authenticated requests SHALL be routed to `app_service:app_port`
- **AND** 404 responses SHALL be replaced with the styled 404 page
- **AND** 5xx responses SHALL be replaced with the styled 5xx page

#### Scenario: Trigger routes with auth

- **WHEN** a request matches `PathPrefix('/trigger')`
- **THEN** the ForwardAuth middleware SHALL verify the request via oauth2-proxy
- **AND** unauthenticated requests SHALL see the oauth2-proxy sign-in page
- **AND** authenticated requests SHALL be routed to `app_service:app_port`
- **AND** 404 responses SHALL be replaced with the styled 404 page
- **AND** 5xx responses SHALL be replaced with the styled 5xx page

#### Scenario: Unknown path returns 404

- **WHEN** a request matches no specific route and falls through to the catch-all
- **THEN** the not-found middleware SHALL intercept the 404 from the app
- **AND** the response SHALL be the styled 404 page

#### Scenario: Root path redirects to trigger

- **WHEN** a request matches `Path('/')`
- **THEN** the user SHALL be redirected to `/trigger` with a 302 status

### Requirement: Not-found errors middleware

The Helm release `extraObjects` SHALL include a Traefik `Middleware` CRD of type `errors` named `not-found`. The middleware SHALL intercept HTTP 404 responses and fetch the replacement content from the app service at `/static/404.html`.

#### Scenario: 404 intercepted and replaced

- **WHEN** the app returns HTTP 404 on a route with the `not-found` middleware
- **THEN** the middleware SHALL fetch `/static/404.html` from the app service
- **AND** the response body SHALL be replaced with the fetched content

### Requirement: Server-error errors middleware

The Helm release `extraObjects` SHALL include a Traefik `Middleware` CRD of type `errors` named `server-error`. The middleware SHALL intercept HTTP 500-599 responses and fetch the replacement content from the Traefik K8s Service on port 80 (web entrypoint) at the `/error` path.

#### Scenario: 5xx intercepted and replaced via loopback

- **WHEN** the app returns HTTP 500 on a route with the `server-error` middleware
- **THEN** the middleware SHALL fetch `/error` from the Traefik service on port 80
- **AND** the response body SHALL be replaced with the inline 5xx error page

### Requirement: Inline error page route on web entrypoint

The Helm release `extraObjects` SHALL include a Traefik `IngressRoute` CRD on the `web` entrypoint with a route matching `Path('/error')`. The route SHALL use the `traefik_inline_response` plugin middleware to serve self-contained 5xx HTML. The backend service SHALL be `noop@internal`.

#### Scenario: Loopback serves inline HTML

- **WHEN** an HTTP request is made to Traefik port 80 at `/error`
- **THEN** the `traefik_inline_response` middleware SHALL return the inline 5xx HTML page
- **AND** the response content type SHALL be detected as `text/html`

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §5 Infrastructure and Deployment`, which enumerates the
trust level, entry points, threats, current mitigations, residual
risks, rules, and production deployment requirements governing this
capability. Infrastructure changes determine the posture of the
running system: network exposure, secret handling, pod security, and
resource isolation.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add new exposed ports or services, alter
secret handling, modify pod security context or resource policy, or
conflict with the rules listed in `/SECURITY.md §5` MUST update
`/SECURITY.md §5` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk,
  rule, or production deployment requirement enumerated in
  `/SECURITY.md §5`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §5`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §5`
- **THEN** no update to `/SECURITY.md §5` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
