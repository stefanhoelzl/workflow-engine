<!-- ═══════════════════════════════════════════════════════ -->
<!-- Local Stack (infrastructure/local/)                    -->
<!-- ═══════════════════════════════════════════════════════ -->

## Purpose

Reusable Terraform modules for the local (kind) and production (UpCloud) stacks.
## Requirements
### Requirement: OpenTofu version constraint

The dev root configuration SHALL require OpenTofu version `>= 1.11`.

#### Scenario: Version check passes

- **WHEN** `tofu apply` is run with OpenTofu 1.11 or later
- **THEN** the version check SHALL pass

#### Scenario: Version check fails

- **WHEN** `tofu apply` is run with OpenTofu older than 1.11
- **THEN** it SHALL fail with an error indicating the minimum required version

### Requirement: Provider version constraints

The dev root SHALL declare required providers with version constraints: `tehcyx/kind ~> 0.11`, `hashicorp/kubernetes ~> 3.0`, `hashicorp/random ~> 3.8`, `hashicorp/null ~> 3.2`. The `hashicorp/helm` provider SHALL NOT be declared (no Helm releases exist post-migration).

#### Scenario: Provider versions pinned

- **WHEN** `tofu init` is run
- **THEN** providers SHALL be installed within the declared version constraints
- **AND** exact versions SHALL be recorded in `.terraform.lock.hcl`
- **AND** `hashicorp/helm` SHALL NOT appear in `.terraform.lock.hcl`

### Requirement: Local state backend

The dev root SHALL use `backend "local" {}`. The state file SHALL be gitignored.

#### Scenario: State stored locally

- **WHEN** `tofu apply` completes
- **THEN** state SHALL be written to `terraform.tfstate` in the dev directory

### Requirement: Module wiring

The local root (`envs/local/local.tf`) SHALL instantiate the following modules: `kubernetes/kind`, `image/build`, `object-storage/s2`, `baseline`, `caddy`, and `app-instance`. The kubernetes provider SHALL be configured from the cluster module's credential outputs. The `caddy` module SHALL receive the local domain, the local upstream Service reference, `service_type=NodePort` (with host-port mapping into the kind container), and a flag selecting `tls internal` for ACME. The `app-instance` module SHALL receive baseline, caddy readiness, and per-instance config.

The local root SHALL NOT instantiate `modules/traefik/` (deleted), `modules/cert-manager/` (deleted), or `modules/netpol/` (deleted; NP rendered inline in callers).

Local stack SHALL NOT include an oauth2-proxy workload — that sidecar was removed by `replace-oauth2-proxy` and replaced by in-app OAuth (see the `auth` capability). Authentication is end-to-end in-app; no sidecar proxies forward-auth.

#### Scenario: Single apply creates everything

- **WHEN** `tofu apply` is run on a clean state
- **THEN** a kind cluster SHALL be created
- **AND** the app image SHALL be built and loaded
- **AND** workload namespaces SHALL be created with PSA labels
- **AND** S2 SHALL be deployed in the `persistence` namespace and the app in its namespace
- **AND** Caddy SHALL be deployed in `ns/caddy` (or co-located in the app namespace; module-decided) with `Service.type=NodePort` and `tls internal`
- **AND** no Traefik, cert-manager, or routes-chart Helm release SHALL be deployed

### Requirement: Non-secret variables in terraform.tfvars

The local root SHALL load non-secret configuration from `terraform.tfvars` (committed): `domain`, `https_port`, `auth_allow`, `s2_bucket`. The `auth_allow` variable SHALL be a string matching the grammar defined in the `auth` capability (comma-separated `provider:rest` entries) and SHALL be passed to the app module as the `AUTH_ALLOW` runtime environment variable.

The legacy `oauth2_github_users` variable SHALL NOT exist; it was removed by `replace-oauth2-proxy` along with the oauth2-proxy sidecar.

#### Scenario: Default local values

- **WHEN** `terraform.tfvars` is read
- **THEN** `domain` SHALL be `"localhost"`
- **AND** `https_port` SHALL be `8443`
- **AND** `auth_allow` SHALL be a comma-separated `AUTH_ALLOW` string (e.g., `"github:user:stefanhoelzl,local:dev"`)

### Requirement: Secret variables in local.secrets.auto.tfvars

The local root SHALL load secrets from `local.secrets.auto.tfvars` (gitignored): `github_oauth_client_id`, `github_oauth_client_secret`. These SHALL be declared as `sensitive = true` variables in `envs/local/local.tf` and fed to the app module's in-app OAuth wiring.

The legacy variable names `oauth2_client_id` / `oauth2_client_secret` SHALL NOT exist — they belonged to the deleted oauth2-proxy sidecar.

#### Scenario: Secrets gitignored

- **WHEN** the `.gitignore` is checked
- **THEN** `*.secrets.auto.tfvars` SHALL be listed as ignored

#### Scenario: Missing secrets file fails

- **WHEN** `tofu apply` is run without `local.secrets.auto.tfvars`
- **THEN** it SHALL fail requesting values for `github_oauth_client_id` and `github_oauth_client_secret`

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
<!-- modules/kubernetes/upcloud/                            -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: UpCloud Kubernetes cluster

The `modules/kubernetes/upcloud/` module SHALL create an `upcloud_network` (utility type) and an `upcloud_kubernetes_cluster` in the specified zone. The cluster SHALL reference the private network.

#### Scenario: Cluster creation

- **WHEN** `tofu apply` is run with `zone = "de-fra1"` and `cluster_name = "workflow-engine"`
- **THEN** a private network SHALL be created in `de-fra1`
- **AND** a Managed Kubernetes cluster SHALL be created referencing that network

### Requirement: Kubernetes version

The kubernetes/upcloud module SHALL accept a `kubernetes_version` variable with no default. The cluster SHALL be created with the specified version.

#### Scenario: Version specified

- **WHEN** `tofu apply` is run with `kubernetes_version = "1.32"`
- **THEN** the cluster SHALL run Kubernetes version `1.32`

### Requirement: Kubernetes node group

The kubernetes/upcloud module SHALL create an `upcloud_kubernetes_node_group` with the specified `node_plan` and `node_count`. The node group SHALL depend on the cluster.

#### Scenario: Single worker node

- **WHEN** `tofu apply` is run with `node_plan = "K8S-2xCPU-4GB"` and `node_count = 1`
- **THEN** one worker node SHALL be provisioned with the specified plan

### Requirement: Ephemeral credential outputs

The kubernetes/upcloud module SHALL use `ephemeral "upcloud_kubernetes_cluster"` to retrieve cluster credentials. The module SHALL output `host`, `cluster_ca_certificate`, `client_certificate`, and `client_key` with `ephemeral = true`. These values SHALL NOT be stored in OpenTofu state.

#### Scenario: Provider configuration from ephemeral outputs

- **WHEN** the kubernetes provider is configured with the module's outputs
- **THEN** it SHALL successfully connect to the UpCloud cluster's API server
- **AND** no credential values SHALL appear in the state file

### Requirement: Kubernetes module output contract

The kubernetes/upcloud module SHALL output the same 4 fields as `modules/kubernetes/kind/`: `host`, `cluster_ca_certificate`, `client_certificate`, `client_key`. Composition roots SHALL be able to use either module interchangeably for provider configuration.

#### Scenario: Contract compatibility

- **WHEN** a composition root switches from `kubernetes/kind` to `kubernetes/upcloud`
- **THEN** the provider configuration block SHALL require no changes

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

<!-- Removed: Image URL construction — see archive/2026-04-16-infra-refactor -->

<!-- Removed: No resources created — see archive/2026-04-16-infra-refactor -->

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
<!-- modules/s3/upcloud/                                    -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: UpCloud S3 output contract

The `modules/s3/upcloud/` module SHALL output `endpoint`, `bucket`, `access_key`, `secret_key` (sensitive), and `region`, matching the contract of `modules/s3/s2/`.

#### Scenario: Outputs match contract

- **WHEN** the module is applied
- **THEN** `endpoint` SHALL be the public Object Storage endpoint URL (https)
- **AND** `bucket` SHALL be the created bucket name
- **AND** `access_key` SHALL be the service user's access key ID
- **AND** `secret_key` SHALL be the service user's secret access key (sensitive)
- **AND** `region` SHALL be `"us-east-1"`

### Requirement: UpCloud S3 bucket creation

The s3/upcloud module SHALL create an `upcloud_managed_object_storage_bucket` in the provided Object Storage instance.

#### Scenario: Bucket created

- **WHEN** `tofu apply` is run with `service_uuid` and `bucket_name = "workflow-engine"`
- **THEN** a bucket named `workflow-engine` SHALL exist in the Object Storage instance

### Requirement: Scoped service user

The s3/upcloud module SHALL create an `upcloud_managed_object_storage_user` and attach a custom IAM policy restricting access to the specified bucket only. The policy SHALL allow `s3:HeadBucket`, `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, and `s3:GetBucketLocation` on the bucket and its contents.

#### Scenario: User can access app bucket

- **WHEN** the service user's credentials are used to call `s3:PutObject` on the `workflow-engine` bucket
- **THEN** the request SHALL succeed

#### Scenario: User cannot access other buckets

- **WHEN** the service user's credentials are used to call `s3:GetObject` on the `terraform-state` bucket
- **THEN** the request SHALL be denied

#### Scenario: User cannot delete bucket

- **WHEN** the service user's credentials are used to call `s3:DeleteBucket` on the `workflow-engine` bucket
- **THEN** the request SHALL be denied

### Requirement: Access key generation

The s3/upcloud module SHALL create an `upcloud_managed_object_storage_user_access_key` with status `Active` for the service user.

#### Scenario: Active access key

- **WHEN** `tofu apply` completes
- **THEN** an active access key SHALL exist for the service user
- **AND** the `access_key_id` and `secret_access_key` SHALL be available as outputs

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/workflow-engine/                                -->
<!-- ═══════════════════════════════════════════════════════ -->

<!-- Removed: Workflow-engine module composes sub-modules — see archive/2026-04-16-infra-refactor -->

<!-- Removed: Workflow-engine module threads oauth2 allow-list to app — see archive/2026-04-16-infra-refactor -->

<!-- ═══════════════════════════════════════════════════════ -->
<!-- modules/workflow-engine/modules/app/                    -->
<!-- ═══════════════════════════════════════════════════════ -->

### Requirement: App Deployment

The module SHALL create a `kubernetes_deployment_v1` running the provided `image` with `spec.replicas = 1`. The container SHALL listen on port 8080.

The Deployment SHALL set `spec.strategy.type = "Recreate"` and SHALL set `spec.template.spec.terminationGracePeriodSeconds = 90`.

The `replicas = 1` invariant is load-bearing for **two** capabilities:

1. The `auth` capability: the session-cookie sealing password is generated in memory at app startup and is not shared across pods. Running more than one replica would cause deterministic cookie-decryption failures whenever a request lands on a pod other than the one that sealed the cookie.

2. The `event-store` capability: the DuckLake catalog (a single DuckDB file at `events.duckdb` in the persistence root) is round-tripped through the storage backend with an unconditional PUT. There is no `If-Match` fence (S2 and UpCloud Object Storage do not implement conditional writes). Two concurrent pods writing to the catalog SHALL silently corrupt it.

`spec.strategy.type = "Recreate"` is therefore correctness-load-bearing: it guarantees Pod-old is fully terminated before Pod-new is scheduled, so there is no temporal overlap that could produce two concurrent writers under normal K8s operation.

`terminationGracePeriodSeconds = 90` covers the SIGTERM drain budget (`EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` default 60 s) plus a margin for the catalog PUTs that flush in-flight invocations.

Raising `replicas` above 1, switching `strategy.type` away from `Recreate`, or attaching a Horizontal Pod Autoscaler / a PodDisruptionBudget that tolerates more than 1 replica SHALL be blocked by the corresponding `auth` and `event-store` invariants recorded in `/SECURITY.md` until the cookie-sealing password is migrated to a shared mechanism AND the DuckLake catalog is migrated to a multi-writer-capable backend (e.g. a Postgres catalog).

#### Scenario: App pod running with a single replica

- **WHEN** `tofu apply` completes
- **THEN** exactly one app pod SHALL be running with the specified image
- **AND** the Deployment's `spec.replicas` SHALL equal 1

#### Scenario: Recreate strategy is set

- **WHEN** `tofu apply` completes
- **THEN** the Deployment's `spec.strategy.type` SHALL equal `"Recreate"`

#### Scenario: Termination grace period is 90 seconds

- **WHEN** `tofu apply` completes
- **THEN** the Deployment's `spec.template.spec.terminationGracePeriodSeconds` SHALL equal 90

#### Scenario: Raising replicas beyond one is blocked by spec invariants

- **GIVEN** a change proposal that sets `spec.replicas > 1` on the app Deployment
- **WHEN** the proposal is reviewed
- **THEN** the proposal SHALL include a migration of the session-cookie sealing password out of in-memory state (recorded in the `auth` capability)
- **AND** the proposal SHALL include a migration of the DuckLake catalog to a multi-writer-capable backend (recorded in the `event-store` capability)
- **AND** SHALL be blocked until both migrations are accepted

#### Scenario: Switching strategy.type away from Recreate is blocked

- **GIVEN** a change proposal that sets `spec.strategy.type` to `"RollingUpdate"` (or any value other than `"Recreate"`) without explicit `maxSurge: 0` constraint
- **WHEN** the proposal is reviewed
- **THEN** the proposal SHALL be rejected unless it can demonstrate that no temporal overlap of pods is possible during rollout

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

### Requirement: App workload network allow-rules

The app pod SHALL be protected by a `NetworkPolicy` that denies all inbound traffic except from Traefik pods on TCP 8080, and denies all outbound traffic except to:

- CoreDNS on TCP/UDP 53 (cluster DNS resolution).
- Persistence object store (either the S2 pod in local dev or UpCloud S3 API endpoints in production) on TCP 443.
- GitHub API (`api.github.com`) on TCP 443 for in-app OAuth + `/user` + `/user/orgs` reads — since the fix is DNS-resolved, the NetworkPolicy SHALL express the allow rule as egress to `0.0.0.0/0` TCP 443 with an explicit FQDN policy if supported, or as a CIDR-free egress rule if not.
- Outbound workflow `fetch()` calls per `hardenedFetch` pipeline (allowed egress to public IPs only, enforced host-side; the NetworkPolicy does not further restrict these because IANA-range filtering is a runtime concern).

The NetworkPolicy SHALL NOT allow inbound from any oauth2-proxy pod — that sidecar no longer exists. The NetworkPolicy remains load-bearing as defence-in-depth per `SECURITY.md §5 R-I1`.

#### Scenario: Non-Traefik inbound rejected

- **WHEN** any pod other than Traefik attempts to connect to the app on `:8080`
- **THEN** the connection SHALL be refused by the NetworkPolicy

#### Scenario: Traefik inbound permitted

- **GIVEN** a request reaching the app from a Traefik pod via Traefik's IngressRoute
- **WHEN** the app receives the request
- **THEN** the NetworkPolicy SHALL permit the connection

### Requirement: Persistence project

`infrastructure/envs/persistence/persistence.tf` SHALL be a standalone OpenTofu project that uses `modules/object-storage/upcloud/` to create the app bucket and scoped user in a manually-created Object Storage instance. It SHALL accept `service_uuid`, `service_endpoint`, and `bucket_name` as input variables. Its state SHALL use an S3 backend (state bucket, key `persistence`, credentials via `TF_VAR_*` variables and `AWS_*` environment variables). It SHALL hold prod's bucket only; staging owns a separate bucket inside `envs/staging/`.

#### Scenario: Persistence project creates bucket and user

- **WHEN** `tofu apply` is run in `infrastructure/envs/persistence/` with a valid `service_uuid`
- **THEN** the prod app bucket and scoped user SHALL be created

#### Scenario: Persistence outputs consumed by prod project

- **WHEN** the prod project reads `terraform_remote_state` with key `persistence`
- **THEN** it SHALL receive `endpoint`, `bucket`, `access_key`, `secret_key`, and `region`

#### Scenario: Cluster destroy does not affect persistence

- **WHEN** `tofu destroy` is run in `infrastructure/envs/cluster/`
- **THEN** the Object Storage instance, bucket, and data SHALL remain intact

#### Scenario: Staging destroy does not affect persistence

- **WHEN** `tofu destroy` is run in `infrastructure/envs/staging/`
- **THEN** the prod bucket in the persistence project SHALL remain intact

### Requirement: S3 configuration from remote state

The prod project SHALL read persistence project outputs via `terraform_remote_state` data source (S3 backend, key `persistence`). The outputs SHALL be passed to the `app-instance` module's `s3` variable. The staging project SHALL NOT read persistence remote state; it SHALL compose its S3 configuration from the bucket it creates itself via `modules/object-storage/upcloud/`.

#### Scenario: Prod S3 config flows from persistence

- **WHEN** `tofu apply` is run in `envs/prod/`
- **THEN** the prod app SHALL receive S3 credentials scoped to the `workflow-engine` bucket from the persistence project

#### Scenario: Staging S3 config is local

- **WHEN** `tofu apply` is run in `envs/staging/`
- **THEN** the staging app SHALL receive S3 credentials scoped to the bucket created in the staging project

### Requirement: CI validates all OpenTofu projects

The CI workflow SHALL run `tofu init -backend=false && tofu validate` for `infrastructure/envs/local/`, `infrastructure/envs/persistence/`, `infrastructure/envs/cluster/`, `infrastructure/envs/prod/`, and `infrastructure/envs/staging/`. The `tofu fmt -check -recursive infrastructure/` check SHALL cover all projects.

#### Scenario: All projects validated in CI

- **WHEN** a pull request is opened
- **THEN** `tofu validate` SHALL run for all five OpenTofu projects
- **AND** `tofu fmt -check` SHALL cover all `.tf` files

### Requirement: Namespace isolation

Workloads SHALL be deployed in dedicated namespaces, not `default`:

- App instances: namespace = instance name (`prod` in the prod project, `staging` in the staging project, `workflow-engine` for local)
- Caddy: namespace `caddy` in cluster + workload envs (created by the cluster project's baseline call); for the local stack, Caddy MAY be co-located in the app namespace.

Each app namespace SHALL be created by its own app project's baseline call — not by the cluster project. The Caddy namespace SHALL be created by the cluster project's baseline call. There SHALL NOT be a `traefik` or `cert-manager` namespace post-migration.

#### Scenario: Default namespace is empty in production

- **WHEN** `tofu apply` completes across all prod projects
- **THEN** no application workloads SHALL be running in the `default` namespace

#### Scenario: Caddy in dedicated namespace

- **WHEN** the cluster project's apply completes
- **THEN** the Caddy Deployment SHALL be deployed in namespace `caddy`
- **AND** no namespaces named `traefik` or `cert-manager` SHALL exist

#### Scenario: App namespaces created by app projects

- **WHEN** the cluster project is applied before any app project
- **THEN** the `prod` and `staging` namespaces SHALL NOT exist

### Requirement: Standardized labels

All workloads SHALL use `app.kubernetes.io/name` (service identity) and `app.kubernetes.io/instance` (instance identity) labels. These labels SHALL be used in Deployment selectors, Service selectors, and NetworkPolicy pod selectors.

#### Scenario: Label consistency

- **WHEN** the workflow-engine Deployment is inspected in namespace `prod`
- **THEN** its labels SHALL include `app.kubernetes.io/name=workflow-engine` and `app.kubernetes.io/instance=prod`

### Requirement: DNS module extraction

The Dynu DNS CNAME record management SHALL be extracted to `modules/dns/dynu/`. The module SHALL accept `domain`, `target_hostname`, and `api_key` inputs and create the restapi provider, domain data lookup, and CNAME record resource.

#### Scenario: DNS module creates CNAME record

- **WHEN** the dns/dynu module is applied with a valid domain and target hostname
- **THEN** a CNAME record SHALL be created pointing the domain at the target hostname

#### Scenario: Provider swap readiness

- **WHEN** a new DNS provider is needed (e.g., Scaleway DNS)
- **THEN** a new `modules/dns/<provider>/` module can be created with the same interface
- **AND** the env root swaps the module source without other changes

### Requirement: Deployment depends on NetworkPolicy

Every `kubernetes_deployment_v1` SHALL declare `depends_on` on its inline NetworkPolicy and on the baseline module. This ensures the NP allow-rules are in place before the pod starts, preventing DNS-blocked-at-boot races on CNIs that enforce NetworkPolicy asynchronously.

The dependency SHALL be expressed as `depends_on = [kubernetes_network_policy_v1.<name>, module.baseline]` (no factory-module reference, since `modules/netpol/` is deleted).

#### Scenario: NP exists before pod starts

- **WHEN** `tofu apply` runs on a clean state
- **THEN** the app's inline NetworkPolicy SHALL be created before the app Deployment
- **AND** the Caddy inline NetworkPolicy SHALL be created before the Caddy Deployment
- **AND** the baseline default-deny NetworkPolicy SHALL be created before any workload Deployment

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

### Requirement: App module accepts auth_allow input

The `modules/app-instance/` module SHALL declare an `auth_allow` input variable (type `string`). The module SHALL inject the value as the `AUTH_ALLOW` environment variable on the app container using a plain `env { name = "AUTH_ALLOW" value = var.auth_allow }` block (i.e., not from a secret), so the allow-list is visible in pod specs and Kubernetes events for auditability.

#### Scenario: auth_allow threaded to pod env

- **WHEN** the `app-instance` module is instantiated with `auth_allow = "github:user:alice;github:org:acme"`
- **THEN** the rendered `kubernetes_deployment_v1.app` SHALL contain a container `env` entry with `name = "AUTH_ALLOW"` and `value = "github:user:alice;github:org:acme"`

#### Scenario: auth_allow empty string

- **WHEN** the `app-instance` module is instantiated with `auth_allow = ""`
- **THEN** the rendered deployment SHALL still include the `AUTH_ALLOW` env var with an empty string value
- **AND** the app SHALL resolve `auth.mode` to `disabled`, rejecting every request with `401 Unauthorized`

### Requirement: App module accepts GitHub OAuth App credentials

The `modules/app-instance/` module SHALL declare two input variables carrying the GitHub OAuth App credentials:

- `github_oauth_client_id` (type `string`) — the OAuth App's client id, injected as the `GITHUB_OAUTH_CLIENT_ID` environment variable via a plain `env {}` block.
- `github_oauth_client_secret` (type `string`, marked `sensitive`) — the OAuth App's client secret, stored in a Kubernetes Secret and injected as the `GITHUB_OAUTH_CLIENT_SECRET` environment variable via `value_from.secret_key_ref`.

The Kubernetes Secret holding the client secret SHALL be created by this module (not oauth2-proxy's module, which no longer exists) and SHALL follow the same naming convention as other app Secrets in the module.

#### Scenario: Client id injected as plain env var

- **WHEN** the `app-instance` module is instantiated with `github_oauth_client_id = "cid123"`
- **THEN** the rendered app Deployment SHALL contain a container `env` entry with `name = "GITHUB_OAUTH_CLIENT_ID"` and `value = "cid123"`

#### Scenario: Client secret injected from Kubernetes Secret

- **WHEN** the `app-instance` module is instantiated with a non-empty `github_oauth_client_secret`
- **THEN** the module SHALL create a `kubernetes_secret_v1` containing the client secret
- **AND** the app container SHALL receive `GITHUB_OAUTH_CLIENT_SECRET` via `value_from.secret_key_ref` referencing that Secret
- **AND** the Terraform plan SHALL NOT print the secret value in plaintext (variable is marked `sensitive`)

### Requirement: Cluster module exposes node CIDR

`modules/kubernetes/upcloud/` SHALL declare the node CIDR as a module-level local and SHALL output it as `node_cidr`. The `upcloud_network.this` resource SHALL reference the local (not a duplicated literal). Consumers SHALL read `module.cluster.node_cidr` instead of hardcoding the literal.

#### Scenario: CIDR declared once in module

- **WHEN** the kubernetes/upcloud module is inspected
- **THEN** the string `172.24.1.0/24` SHALL appear exactly once (in the local declaration)
- **AND** the `upcloud_network.this` resource's `ip_network.address` SHALL reference `local.node_cidr`
- **AND** the module SHALL output `node_cidr` with that value

#### Scenario: Composition roots consume output

- **WHEN** the cluster composition root wires the baseline module
- **THEN** it SHALL pass `node_cidr = module.cluster.node_cidr`
- **AND** no env-level file SHALL contain the literal `172.24.1.0/24`

### Requirement: Cluster project composition root

`infrastructure/envs/cluster/` SHALL be an OpenTofu project that wires: `modules/kubernetes/upcloud`, `modules/baseline` (with `namespaces = ["caddy"]`), `modules/caddy` (with `service_type = "LoadBalancer"`, the UpCloud LB annotation, and HTTP-01 ACME enabled), and the LB hostname lookup via the `upcloud` provider data source. It SHALL NOT instantiate `modules/app-instance/`, `modules/dns/dynu/`, `modules/traefik/` (deleted), or `modules/cert-manager/` (deleted), and SHALL NOT declare a `helm` provider. It SHALL use an S3 backend with key `cluster`.

#### Scenario: Cluster apply provisions cluster-scoped infrastructure

- **WHEN** `tofu apply` is run in `infrastructure/envs/cluster/`
- **THEN** a K8s cluster SHALL be created on UpCloud
- **AND** the `caddy` namespace SHALL be created with the PSA restricted label
- **AND** the Caddy Deployment SHALL be running with a LoadBalancer Service carrying the UpCloud LB annotation
- **AND** Caddy SHALL have obtained a Let's Encrypt certificate via HTTP-01 (assuming the cluster's LB hostname is reachable from the public internet — verified out-of-band by the operator)
- **AND** no Traefik Helm release, cert-manager Helm release, ClusterIssuer, or app workloads SHALL be present

#### Scenario: Cluster is env-agnostic

- **WHEN** the cluster project's `.tf` files are searched for `prod` or `staging`
- **THEN** no substring match SHALL be found
- **AND** the cluster project SHALL be applyable without any knowledge of which app envs consume it

### Requirement: Cluster project outputs

The cluster project SHALL export the following non-sensitive outputs for downstream app projects:

- `cluster_id`: UpCloud Kubernetes cluster UUID
- `lb_hostname`: Caddy LoadBalancer DNS name (from the `upcloud` provider data source)
- `node_cidr`: pass-through from `module.cluster.node_cidr`
- `caddy_namespace`: name of the namespace where Caddy is deployed (default `"caddy"`), used by app projects to authorize ingress in the inline app NetworkPolicy
- `baseline`: object bundling `pod_security_context` and `container_security_context` for downstream consumption

The cluster project SHALL NOT export `active_issuer_name` (no cert-manager). It SHALL NOT export `rfc1918_except` or `coredns_selector` directly on the `baseline` output if no remaining consumer reads them; otherwise these MAY be retained pending app-instance inline NP consumption.

No sensitive value (kubeconfig, private keys, API tokens) SHALL appear in cluster project outputs.

#### Scenario: Apps can read cluster outputs

- **WHEN** an app project declares `data "terraform_remote_state" "cluster"` pointing at state key `cluster`
- **THEN** it SHALL be able to read `cluster_id`, `lb_hostname`, `node_cidr`, `caddy_namespace`, and `baseline`
- **AND** it SHALL NOT receive `active_issuer_name` (does not exist post-migration)

#### Scenario: No sensitive values cross project boundaries

- **WHEN** the cluster project's state file is decrypted and inspected
- **THEN** no kubeconfig host, CA cert, client cert, client key, or UpCloud API token value SHALL be present in the outputs section

### Requirement: Apps re-fetch kubeconfig via ephemeral block

Each app project (`envs/prod/`, `envs/staging/`) SHALL declare an `ephemeral "upcloud_kubernetes_cluster"` block keyed by `data.terraform_remote_state.cluster.outputs.cluster_id`. The `kubernetes` and `helm` providers SHALL be configured from `ephemeral.upcloud_kubernetes_cluster.this.host` / `.cluster_ca_certificate` / `.client_certificate` / `.client_key`. App projects SHALL hold their own `TF_VAR_upcloud_token` (scoped to K8s-read).

#### Scenario: App apply configures providers from ephemeral block

- **WHEN** `tofu apply` is run in `envs/prod/`
- **THEN** the kubernetes provider SHALL connect to the cluster's API server using credentials read from the ephemeral block
- **AND** no kubeconfig value SHALL be persisted in the prod project's state

#### Scenario: App projects require UpCloud token

- **WHEN** `tofu apply` is run in `envs/prod/` or `envs/staging/` without `TF_VAR_upcloud_token`
- **THEN** the apply SHALL fail at the ephemeral block with a missing-credentials error

### Requirement: App project composition root

Each app project (`envs/prod/`, `envs/staging/`) SHALL wire: `data "terraform_remote_state" "cluster"`, an `ephemeral "upcloud_kubernetes_cluster"` block, `modules/baseline` (with its own `namespaces = [var.namespace]`), `modules/app-instance/`, and `modules/dns/dynu/`. It SHALL use an S3 backend with key `prod` or `staging` respectively. It SHALL NOT declare a `helm` provider. It SHALL NOT instantiate or reference any `Certificate` resource, any `acme-solver` NetworkPolicy, or any `IngressRoute`/`Middleware` CRD (none exist post-migration; routing is owned by the cluster-scoped Caddy module).

#### Scenario: Prod apply deploys app in prod namespace

- **WHEN** `tofu apply` is run in `envs/prod/`
- **THEN** the `prod` namespace SHALL be created with the PSA restricted label
- **AND** a default-deny NetworkPolicy SHALL be created in the `prod` namespace (owned by `pod-security-baseline`)
- **AND** the app Deployment, Service, and inline app NetworkPolicy SHALL be deployed in `prod`
- **AND** no `Certificate` resource, no `IngressRoute`, and no `acme-solver` NetworkPolicy SHALL be created
- **AND** a Dynu CNAME record SHALL point the prod domain at the cluster's Caddy LB hostname

#### Scenario: Staging apply deploys app in staging namespace with own bucket

- **WHEN** `tofu apply` is run in `envs/staging/`
- **THEN** a new S3 bucket SHALL be created via `modules/object-storage/upcloud/`
- **AND** the `staging` namespace SHALL be created
- **AND** the staging Deployment SHALL be deployed in `staging` with S3 credentials pointing at the staging bucket

### Requirement: Prod image identity via digest

The prod project SHALL declare `variable image_digest { type = string }` (no default — supplied at apply time by the prod deploy workflow). The image reference SHALL be constructed as `"ghcr.io/stefanhoelzl/workflow-engine@${var.image_digest}"`. It SHALL pass `image_hash = var.image_digest` to the `app-instance` module. The prod project SHALL NOT declare or use an `image_tag` variable; `prod/terraform.tfvars` SHALL NOT contain an `image_tag` entry.

#### Scenario: Prod image pinned by digest

- **WHEN** `tofu apply` is run in `envs/prod/` with `-var image_digest=sha256:abc...`
- **THEN** the prod Deployment's container image SHALL be `ghcr.io/stefanhoelzl/workflow-engine@sha256:abc...`

#### Scenario: Missing digest fails apply

- **WHEN** `tofu apply` is run in `envs/prod/` without providing `image_digest`
- **THEN** the apply SHALL fail with a missing-variable error

#### Scenario: Digest change triggers rollout

- **WHEN** `image_digest` changes between successive applies
- **THEN** the Deployment's pod template `sha256/image` annotation SHALL change
- **AND** Kubernetes SHALL perform a rolling update

### Requirement: Staging image identity via digest

The staging project SHALL declare `variable image_digest { type = string }` (no default — supplied at apply time). The image reference SHALL be constructed as `"ghcr.io/stefanhoelzl/workflow-engine@${var.image_digest}"`. It SHALL pass `image_hash = var.image_digest` to the `app-instance` module.

#### Scenario: Staging image pinned by digest

- **WHEN** `tofu apply` is run with `-var image_digest=sha256:abc...`
- **THEN** the staging Deployment's container image SHALL be `ghcr.io/stefanhoelzl/workflow-engine@sha256:abc...`

#### Scenario: Missing digest fails apply

- **WHEN** `tofu apply` is run in `envs/staging/` without providing `image_digest`
- **THEN** the apply SHALL fail with a missing-variable error

### Requirement: Staging bucket inside staging project

The staging project SHALL instantiate `modules/object-storage/upcloud/` directly (passing `service_uuid`, `service_endpoint`, and `bucket_name` as inputs) rather than reading from the persistence project's remote state. The staging bucket lifecycle SHALL be coupled to the staging project: `tofu destroy` in `envs/staging/` SHALL delete the bucket and its contents.

#### Scenario: Staging creates its own bucket

- **WHEN** `tofu apply` is run in `envs/staging/` on a clean slate
- **THEN** a new S3 bucket SHALL exist on the configured Object Storage instance
- **AND** the staging app SHALL receive its own S3 credentials pointing at that bucket

#### Scenario: Staging destroy removes bucket

- **WHEN** `tofu destroy` is run in `envs/staging/`
- **THEN** the staging bucket and its contents SHALL be deleted
- **AND** the prod bucket in the persistence project SHALL remain intact

### Requirement: DNS ownership per app project

Each app project SHALL instantiate `modules/dns/dynu/` with its own domain and `target_hostname = data.terraform_remote_state.cluster.outputs.lb_hostname`. The cluster project SHALL NOT instantiate `modules/dns/dynu/`.

#### Scenario: Prod creates its own DNS record

- **WHEN** `tofu apply` is run in `envs/prod/`
- **THEN** a Dynu CNAME record SHALL exist for `workflow-engine.webredirect.org` pointing at the Traefik LB hostname

#### Scenario: Staging creates its own DNS record

- **WHEN** `tofu apply` is run in `envs/staging/`
- **THEN** a Dynu CNAME record SHALL exist for `staging.workflow-engine.webredirect.org` pointing at the Traefik LB hostname

#### Scenario: Cluster owns no DNS records

- **WHEN** `tofu destroy` is run in `envs/cluster/`
- **THEN** no Dynu records SHALL be destroyed by that apply

### Requirement: State key layout

The S3 state backend SHALL use these keys, one per project:

- `persistence` — prod app bucket
- `cluster` — K8s cluster, Traefik, cert-manager
- `prod` — prod app resources
- `staging` — staging app resources (+ its bucket)

No project SHALL use the retired state key `upcloud`.

#### Scenario: Each project has its own state

- **WHEN** `tofu init` is run in any project directory
- **THEN** the backend SHALL resolve to the project's dedicated state key

#### Scenario: Retired state key is absent

- **WHEN** the `tofu-state` bucket is listed after migration
- **THEN** no object with key `upcloud` SHALL exist

### Requirement: Per-project provider versions

Each project SHALL declare its `required_providers`:

- persistence: `UpCloudLtd/upcloud ~> 5.0`
- cluster: `UpCloudLtd/upcloud ~> 5.0`, `hashicorp/kubernetes ~> 3.0`, `hashicorp/random ~> 3.8`, `hashicorp/local ~> 2.5`
- prod: `UpCloudLtd/upcloud ~> 5.0`, `hashicorp/kubernetes ~> 3.0`, `Mastercard/restapi`
- staging: same as prod

The `hashicorp/helm` and `hashicorp/http` providers SHALL NOT be declared by any project (no Helm releases exist; LB hostname lookup uses the `upcloud` provider).

#### Scenario: Tofu init resolves providers per project

- **WHEN** `tofu init` is run in any project
- **THEN** only that project's declared providers SHALL be downloaded into its `.terraform/` directory
- **AND** `hashicorp/helm` and `hashicorp/http` SHALL NOT be downloaded

### Requirement: Per-project variables and tfvars

Each project SHALL declare only the variables it uses. Non-secret values SHALL live in the project's `terraform.tfvars`; secrets SHALL be supplied via `TF_VAR_*` environment variables. Values injected at apply time by CI (such as image digests) SHALL NOT be committed to `terraform.tfvars`.

- cluster tfvars: `acme_email`
- prod tfvars: `domain`, `auth_allow`
- staging tfvars: `domain`, `auth_allow`, `service_uuid`, `service_endpoint`, `bucket_name`

#### Scenario: Prod tfvars does not reference cluster state passphrase

- **WHEN** `prod/terraform.tfvars` is read
- **THEN** it SHALL contain `domain` and `auth_allow`
- **AND** it SHALL NOT contain `state_passphrase`, `upcloud_token`, `dynu_api_key`, `github_oauth_client_id`, `github_oauth_client_secret`, `image_tag`, or `image_digest`

### Requirement: Per-env URL outputs

Each app project SHALL output `url = "https://${var.domain}"`. The cluster project SHALL NOT output a URL (it does not serve user traffic).

#### Scenario: Prod outputs its URL

- **WHEN** `tofu apply` completes in `envs/prod/`
- **THEN** the output SHALL include `url = "https://workflow-engine.webredirect.org"`

#### Scenario: Staging outputs its URL

- **WHEN** `tofu apply` completes in `envs/staging/`
- **THEN** the output SHALL include `url = "https://staging.workflow-engine.webredirect.org"`

### Requirement: Drift guard via plan-infra.yml

The repository SHALL maintain `.github/workflows/plan-infra.yml` running on every pull request targeting `main`. The workflow SHALL execute `tofu plan -detailed-exitcode -lock=false -no-color` against each operator-driven project in a matrix strategy. The matrix SHALL currently include `cluster` and `persistence`. A non-empty plan from any matrix entry SHALL fail the corresponding check; the check name SHALL be `plan (<project>)`.

The `main` branch ruleset SHALL declare `plan (cluster)` and `plan (persistence)` in its `required_status_checks` list alongside `ci` and any other required checks. `bypass_actors` SHALL be `[]` — no per-PR admin bypass. The `strict_required_status_checks_policy` SHALL be `true` so a PR must be up-to-date with `main` before merging.

The `release` branch SHALL have its own protection ruleset preventing force-push and deletion (not covered by the `main` ruleset since `release` is the prod deployment source).

Operator flow for drift-guarded projects (`envs/cluster/` + `envs/persistence/`):

1. `git pull --rebase origin main` — required before local `tofu apply` to avoid reverting another operator's in-flight work.
2. Edit `.tf` files locally.
3. `tofu -chdir=infrastructure/envs/<project> apply` — updates state to match the edited config.
4. Commit edits, push, open PR to `main`.
5. `plan (cluster)` and `plan (persistence)` both report empty plans → green → merge.

#### Scenario: Empty plan passes the check

- **GIVEN** a PR that changed only comments in `envs/cluster/*.tf`
- **WHEN** `plan-infra.yml` runs
- **THEN** `tofu plan -detailed-exitcode` SHALL return exit code 0 for cluster
- **AND** the `plan (cluster)` check SHALL pass

#### Scenario: Non-empty plan blocks merge

- **GIVEN** a PR that added a resource to `envs/cluster/*.tf` without the operator having run `tofu apply` first
- **WHEN** `plan-infra.yml` runs
- **THEN** `tofu plan -detailed-exitcode` SHALL return exit code 2 for cluster
- **AND** the `plan (cluster)` check SHALL fail
- **AND** the PR SHALL be blocked from merging by the `main` ruleset's required-status-checks rule

#### Scenario: No admin bypass

- **GIVEN** a repository admin opening a PR whose `plan (cluster)` check is failing
- **WHEN** they attempt to merge
- **THEN** the merge SHALL be blocked
- **AND** the only recovery SHALL be to fix the drift or to temporarily flip the ruleset's `enforcement` field to `disabled` via `gh api PUT`

### Requirement: Helm-rendered-object drift blind spot

Operators SHALL NOT bypass Helm for drift-guard-protected workloads. The drift guard (`plan-infra.yml`) detects drift only in Terraform-managed fields: Helm chart versions, module arguments, K8s manifests declared directly by Terraform. Raw `kubectl edit` on an object rendered *inside* a Helm release (e.g., hand-editing the Traefik Deployment rendered by the Traefik Helm chart) produces drift the gate cannot see, because Terraform tracks the Helm release version, not its rendered objects.

This is a documented operational norm, not a physical constraint — Terraform has no way to enforce it. The project's policy is: anything that should be drift-protected SHALL be expressed through Terraform (either as a Helm release module argument or as a direct Terraform-managed Kubernetes resource); anything hand-edited via `kubectl` is explicitly unguarded and SHALL be returned to its desired state promptly.

#### Scenario: Helm rendered Traefik Deployment is not drift-guarded

- **GIVEN** an operator runs `kubectl edit deployment traefik -n traefik` and changes the replica count
- **WHEN** `plan-infra.yml` runs on any subsequent PR
- **THEN** the plan SHALL show zero changes (Terraform tracks the Helm release version, not its rendered Deployment)
- **AND** the edit SHALL be recorded as an operational mistake, not an infra-as-code change

### Requirement: auth_allow sourced from GitHub repo variables

The `auth_allow` tfvar for prod and staging SHALL NOT be committed in `infrastructure/envs/prod/terraform.tfvars` or `infrastructure/envs/staging/terraform.tfvars`. It SHALL be sourced from GitHub repository variables (not secrets — the allowlist is not confidential):

- `AUTH_ALLOW_PROD` → fed to `envs/prod/` via `TF_VAR_auth_allow` in `deploy-prod.yml`.
- `AUTH_ALLOW_STAGING` → fed to `envs/staging/` via `TF_VAR_auth_allow` in `deploy-staging.yml`.

The TF variable SHALL remain required (no default). An unset GitHub variable SHALL expand to empty string at apply time, which the runtime's `createConfig` maps to the empty provider-registry posture (every protected route SHALL respond 401/302 — fail-closed at runtime, not at apply).

`infrastructure/envs/local/terraform.tfvars` SHALL continue to commit `auth_allow` inline (developer-operated).

#### Scenario: GH variable feeds TF_VAR

- **GIVEN** `AUTH_ALLOW_PROD = "github:user:alice,github:org:acme"` is set as a GitHub repo variable
- **WHEN** `deploy-prod.yml` runs
- **THEN** the `apply` job SHALL export `TF_VAR_auth_allow` to that value before running `tofu apply`
- **AND** the rendered app Deployment SHALL have `AUTH_ALLOW = "github:user:alice,github:org:acme"` in its env

#### Scenario: Unset GH variable yields empty-registry runtime posture

- **GIVEN** `AUTH_ALLOW_PROD` is unset
- **WHEN** `deploy-prod.yml` runs
- **THEN** `TF_VAR_auth_allow` SHALL expand to empty string
- **AND** `tofu apply` SHALL succeed (no validation error — the variable is declared but optional at the runtime layer)
- **AND** the app SHALL start successfully but respond 401/302 on every protected route

### Requirement: Release branch powers automated prod deploys

Production deploys SHALL run via `.github/workflows/deploy-prod.yml` triggered on push to the long-lived `release` branch. The workflow SHALL be split into two jobs:

1. `plan` — builds + pushes `ghcr.io/stefanhoelzl/workflow-engine:release`, captures the image digest from the `docker/build-push-action` output, and renders `tofu plan` into the GitHub run summary. Outputs the digest.
2. `apply` — declares `environment: production` to trigger the required-reviewer gate; on approval, runs `tofu apply -var image_digest=<digest>` against `envs/prod/`; fetches kubeconfig via `upctl`; blocks on `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m`.

Operator rollback flow: `git revert <bad-sha>` on the `release` branch, then `git push origin release` — the workflow rebuilds the previous code and redeploys.

Required repo secrets for prod: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_SECRET_PROD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

#### Scenario: Push to release triggers plan + approval + apply

- **WHEN** a commit is pushed to the `release` branch
- **THEN** `deploy-prod.yml` SHALL start
- **AND** the `plan` job SHALL complete automatically, producing a digest output
- **AND** the `apply` job SHALL enter a "waiting for approval" state
- **AND** the configured reviewers SHALL be notified
- **AND** on approval, `tofu apply -var image_digest=<digest>` SHALL run
- **AND** the apply SHALL block on `kubectl wait` for the prod Certificate to become Ready

#### Scenario: Release branch is protected

- **WHEN** any user attempts `git push --force origin release`
- **THEN** the push SHALL be rejected by branch protection
- **AND** deletion of the `release` branch SHALL also be rejected

### Requirement: Staging auto-deploys on push to main

Staging deploys SHALL run via `.github/workflows/deploy-staging.yml` triggered on push to `main`. The workflow SHALL build + push `ghcr.io/stefanhoelzl/workflow-engine:main`, capture the digest from `docker/build-push-action`, and run `tofu apply -var image_digest=<digest>` against `envs/staging/`.

Required repo secrets for staging: `TF_VAR_STATE_PASSPHRASE`, `TF_VAR_UPCLOUD_TOKEN`, `TF_VAR_DYNU_API_KEY`, `TF_VAR_OAUTH2_CLIENT_ID`, `TF_VAR_OAUTH2_CLIENT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

The first staging deploy SHALL be bootstrapped via `workflow_dispatch`: an operator triggers the workflow manually to capture a digest, then runs `tofu -chdir=infrastructure/envs/staging apply -var image_digest=sha256:...` locally to establish initial state.

#### Scenario: Push to main triggers staging deploy

- **WHEN** a commit is pushed to `main`
- **THEN** `deploy-staging.yml` SHALL run
- **AND** the build SHALL produce a digest
- **AND** `tofu apply` SHALL run against `envs/staging/` with that digest
- **AND** no approval gate SHALL block the apply (staging is unattended)

### Requirement: cert-manager Helm chart CRD upgrade caveat

cert-manager SHALL be installed via Helm release by the `modules/cert-manager/` module. The Helm release SHALL be configured with `installCRDs=true`, which installs CRDs only on FIRST-release install (not on subsequent `helm upgrade` calls). When bumping the cert-manager chart version in the module, operators SHALL manually apply the new CRDs before running `tofu apply`:

```
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/<new-version>/cert-manager.crds.yaml
tofu -chdir=infrastructure/envs/cluster apply
```

Failure to apply CRDs before apply SHALL produce a Helm upgrade error if the new chart references CRD fields not present in the live API surface.

#### Scenario: CRD-first upgrade flow

- **GIVEN** an operator bumping cert-manager from vA to vB in `infrastructure/modules/cert-manager/cert-manager.tf`
- **WHEN** they run `kubectl apply -f .../releases/download/vB/cert-manager.crds.yaml` against the cluster
- **AND** then run `tofu -chdir=infrastructure/envs/cluster apply`
- **THEN** the Helm upgrade SHALL succeed

### Requirement: Cert readiness verification

After `tofu apply` on an app project completes, operators SHALL verify ACME HTTP-01 issuance has produced a served certificate. `tofu apply` returns once K8s resources are created; ACME issuance happens asynchronously over ~30-90 s. The verification command SHALL be:

- Prod: `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m`
- Staging: `kubectl wait --for=condition=Ready certificate/staging-workflow-engine -n staging --timeout=5m`

Failure of that wait SHALL indicate a misconfiguration — DNS resolution, port 80 reachability, CAA records, or ClusterIssuer state. Operators SHALL inspect via `kubectl describe certificate <name> -n <ns>` and `kubectl describe challenge -n <ns>` to diagnose.

The `deploy-prod.yml` `apply` job SHALL embed the prod `kubectl wait` command as its final step so CI failure signals cert-readiness failure, not just apply failure.

#### Scenario: Cert ready after prod apply

- **GIVEN** `deploy-prod.yml`'s `apply` job has just run `tofu apply`
- **WHEN** the `kubectl wait --for=condition=Ready certificate/prod-workflow-engine -n prod --timeout=5m` step runs
- **THEN** it SHALL complete within 5 minutes when DNS + port 80 + CAA are correctly configured

### Requirement: Persistence project generates secrets keypair list

`infrastructure/envs/persistence/` SHALL generate a list of X25519 keypairs via `random_bytes` resources, one per entry in a `var.secret_key_ids` list variable. The primary (active sealing) key SHALL be the first entry in the list.

```hcl
variable "secret_key_ids" {
  type    = list(string)
  default = ["k1"]
}

resource "random_bytes" "secret_key" {
  for_each = toset(var.secret_key_ids)
  length   = 32
}

output "secrets_private_keys" {
  sensitive = true
  value = join(",", [
    for id in var.secret_key_ids : "${id}:${random_bytes.secret_key[id].base64}"
  ])
}
```

The output `secrets_private_keys` SHALL be a sensitive CSV string of `keyId:base64(sk)` entries in the declared order. Rotation SHALL be performed by prepending a new id to `var.secret_key_ids` and running `tofu apply`.

#### Scenario: Default state generates one key

- **GIVEN** `var.secret_key_ids` defaults to `["k1"]`
- **WHEN** `tofu apply` runs in `envs/persistence/`
- **THEN** the state SHALL contain one `random_bytes.secret_key["k1"]` resource with 32 bytes
- **AND** the `secrets_private_keys` output SHALL be `"k1:<base64>"`

#### Scenario: Adding a second id preserves the first

- **GIVEN** existing state with `var.secret_key_ids = ["k1"]`
- **WHEN** `var.secret_key_ids` is updated to `["k2", "k1"]` and `tofu apply` runs
- **THEN** `random_bytes.secret_key["k1"]` SHALL remain unchanged
- **AND** a new `random_bytes.secret_key["k2"]` resource SHALL be created
- **AND** `secrets_private_keys` SHALL be `"k2:<b64_new>,k1:<b64_existing>"`

#### Scenario: Output is marked sensitive

- **GIVEN** the persistence output
- **WHEN** rendered in `tofu plan` or `tofu apply`
- **THEN** the value SHALL be displayed as `(sensitive value)` and not in plaintext

### Requirement: Prod project reads persistence output and creates K8s Secret

`infrastructure/envs/prod/` SHALL read `secrets_private_keys` via a `terraform_remote_state` data source on the persistence state and create a `kubernetes_secret_v1` resource named `app-secrets-key` in the prod namespace with a single data key `SECRETS_PRIVATE_KEYS` set to the persistence output.

```hcl
data "terraform_remote_state" "persistence" { ... }

resource "kubernetes_secret_v1" "secrets_key" {
  metadata { name = "app-secrets-key"; namespace = "prod" }
  data = {
    SECRETS_PRIVATE_KEYS =
      data.terraform_remote_state.persistence.outputs.secrets_private_keys
  }
}
```

#### Scenario: Prod apply creates the secret

- **GIVEN** persistence output has been produced and prod project has the remote_state wiring
- **WHEN** `tofu apply` runs in `envs/prod/`
- **THEN** K8s SHALL have a Secret named `app-secrets-key` in the prod namespace
- **AND** the secret SHALL have one data key `SECRETS_PRIVATE_KEYS` matching the persistence output

### Requirement: Staging and local projects generate own keypairs

`infrastructure/envs/staging/` and `infrastructure/envs/local/` SHALL each generate their own keypair list via local `random_bytes` resources (not via persistence remote state), and create their own `app-secrets-key` K8s Secret in their respective namespaces. The variable and resource structure SHALL mirror the persistence project's shape.

Losing staging or local state SHALL NOT require cross-environment coordination; each environment's keypair is independent.

#### Scenario: Staging apply generates independent keypair

- **GIVEN** `envs/staging/` has its own `var.secret_key_ids`
- **WHEN** `tofu apply` runs
- **THEN** the staging keypair SHALL be generated from local state, not from persistence remote_state
- **AND** a K8s Secret `app-secrets-key` SHALL be created in the staging namespace

#### Scenario: Local apply generates independent keypair

- **GIVEN** `envs/local/` has its own `var.secret_key_ids`
- **WHEN** `tofu apply` runs against the kind cluster
- **THEN** a K8s Secret `app-secrets-key` SHALL be created in the local namespace with a fresh keypair CSV

### Requirement: App pod env_from references app-secrets-key

`infrastructure/modules/app-instance/workloads.tf` SHALL add one `env_from.secret_ref { name = "app-secrets-key" }` block to the app container spec. The block SHALL inject the `SECRETS_PRIVATE_KEYS` key from the Secret into the container's env vars. This block SHALL be in addition to the existing `env_from` blocks for `app-s3-credentials` and `app-github-oauth`.

#### Scenario: App pod has SECRETS_PRIVATE_KEYS env var

- **GIVEN** the app deployment is applied with the env_from block
- **WHEN** a pod starts
- **THEN** `printenv SECRETS_PRIVATE_KEYS` inside the pod SHALL yield the non-empty CSV from the Secret
- **AND** no other new env vars SHALL be added by this change

### Requirement: Caddy module renders Deployment + Service + ConfigMap + PVC

The `modules/caddy/` OpenTofu module SHALL render the cluster ingress as raw `kubernetes_manifest` resources (no Helm chart). The module SHALL declare:

- A `kubernetes_deployment_v1` running the upstream `caddy` container image (pinned to a specific tag), with a single replica, mounting the ConfigMap as `/etc/caddy/Caddyfile` and the cert-storage PVC as `/data`.
- A `kubernetes_service_v1` of type configurable via input (default `LoadBalancer`; `NodePort` for the local kind stack), exposing TCP `:80` and `:443` and selecting the Caddy pod by `app.kubernetes.io/name=caddy`. When `LoadBalancer`, the Service SHALL carry the `service.beta.kubernetes.io/upcloud-load-balancer-config` annotation declaring `web` and `websecure` frontends in `tcp` mode (matching the legacy Traefik LB configuration so the UpCloud LB hostname is reusable).
- A `kubernetes_config_map_v1` carrying a single `Caddyfile` key whose content is `{$DOMAIN} { reverse_proxy {$UPSTREAM} }` plus `admin off` at the global level. Domain and upstream are injected via container `env` from module variables.
- A `kubernetes_persistent_volume_claim_v1` (10Gi default, configurable) bound at `/data` for ACME account, certificates, and OCSP staples.
- A `kubernetes_service_account_v1` with no `automountServiceAccountToken`.

The Deployment's pod-level `securityContext` SHALL set `runAsNonRoot=true`, `runAsUser=65532`, `runAsGroup=65532`, `fsGroup=65532`, `fsGroupChangePolicy=OnRootMismatch`, `seccompProfile={type: RuntimeDefault}`. The container-level `securityContext` SHALL set `allowPrivilegeEscalation=false`, `readOnlyRootFilesystem=true`, `capabilities.drop=[ALL]`. Writable paths (`/config`, `/var/log`) SHALL be backed by `emptyDir` volumes.

#### Scenario: Caddy Deployment is rendered without Helm

- **WHEN** `tofu plan` is run on a project that calls `modules/caddy/`
- **THEN** the planned resources SHALL include `kubernetes_deployment_v1`, `kubernetes_service_v1`, `kubernetes_config_map_v1`, `kubernetes_persistent_volume_claim_v1`, and `kubernetes_service_account_v1` for Caddy
- **AND** no `helm_release` resource SHALL be present in the plan for Caddy

#### Scenario: LoadBalancer Service carries the UpCloud annotation

- **WHEN** the Caddy module is instantiated with the default Service type for the cluster env
- **THEN** the rendered Service SHALL be `type=LoadBalancer`
- **AND** it SHALL carry the annotation `service.beta.kubernetes.io/upcloud-load-balancer-config` whose JSON value declares `frontends=[{name=web,mode=tcp},{name=websecure,mode=tcp}]`

#### Scenario: PSA-restricted compatibility

- **WHEN** the Caddy pod is created in a namespace labeled `pod-security.kubernetes.io/enforce=restricted`
- **THEN** the pod SHALL be admitted (security context conforms to the `restricted` profile)
- **AND** `runAsNonRoot=true` and `seccompProfile=RuntimeDefault` SHALL be present on the pod
- **AND** `capabilities.drop=[ALL]` SHALL be present on the container

#### Scenario: Caddy admin endpoint disabled

- **WHEN** the rendered ConfigMap is inspected
- **THEN** the Caddyfile SHALL contain a global `admin off` directive
- **AND** no Service port SHALL expose the Caddy admin API (default `:2019`)

### Requirement: Caddy serves TLS via HTTP-01 ACME for the configured domain

Caddy SHALL serve HTTPS on the configured `$DOMAIN` using an automatically-issued Let's Encrypt certificate via the HTTP-01 challenge. The ACME account email SHALL be configured via the `acme_email` Caddyfile directive (sourced from the existing `acme_email` Tofu variable consumed today by cert-manager). The certificate, ACME account, and OCSP staple SHALL be persisted on the `/data` PVC.

Caddy SHALL automatically redirect HTTP traffic on `:80` to HTTPS on `:443` for the configured host (Caddy default behavior). HTTP-01 challenge requests on `:80` SHALL be served before the redirect rule fires (Caddy default behavior).

**Local deviation:** in the local kind stack, the Caddyfile SHALL use the `tls internal` directive (Caddy's internal CA) instead of an ACME issuer. Browsers SHALL surface a self-signed warning on `https://localhost:<port>`; this is accepted for local dev. No `:80` exposure to the public internet is implied locally.

#### Scenario: Production cert is issued via Let's Encrypt

- **WHEN** the cluster project is applied with `acme_email` set and the prod domain CNAME points at the Caddy LoadBalancer hostname
- **THEN** Caddy SHALL obtain a publicly-trusted certificate within the LE retry budget
- **AND** `kubectl logs deploy/caddy -n caddy` SHALL contain a `certificate obtained successfully` log line
- **AND** the certificate SHALL be persisted to the `/data` PVC

#### Scenario: HTTP request redirects to HTTPS

- **WHEN** an unauthenticated client sends `GET http://<domain>/anything`
- **THEN** the response SHALL be `301` (or `308`) with `Location: https://<domain>/anything`

#### Scenario: HTTP-01 challenge precedes redirect

- **WHEN** an ACME server requests `GET http://<domain>/.well-known/acme-challenge/<token>` during issuance
- **THEN** Caddy SHALL serve the challenge response with `200 OK` (no redirect)

#### Scenario: Local stack uses tls internal

- **WHEN** the local kind stack is applied
- **THEN** the rendered Caddyfile SHALL contain a `tls internal` directive for the configured local domain
- **AND** browsers SHALL surface a self-signed warning when visiting `https://<local-domain>:<https_port>`
- **AND** no ACME account SHALL be created for the local stack

### Requirement: Caddy reverse-proxies all paths to the app Service

The Caddyfile SHALL contain exactly one site block matching the configured `$DOMAIN`, with a single `reverse_proxy` directive pointing at the app Service ClusterIP on `:8080`. No path-based routing rules, no middleware-equivalent directives (rewrite, header manipulation), and no auth directives SHALL be present. All URL dispatch (`/dashboard`, `/trigger`, `/auth`, `/login`, `/static`, `/webhooks`, `/api`, `/livez`, `/`, the unknown-path fallback) is performed by the app's Hono router. Security headers (CSP, HSTS, Permissions-Policy, X-Frame-Options, etc.) are set by the app's `secure-headers.ts` middleware; Caddy SHALL NOT add or modify response headers.

#### Scenario: Single catch-all routes all prefixes to the app

- **WHEN** a request arrives at `https://<domain>/dashboard` with any trailing path
- **THEN** Caddy SHALL forward the request to `<app-service>:8080`

#### Scenario: Webhook prefix routes through the catch-all

- **WHEN** a `POST` to `https://<domain>/webhooks/<tenant>/<workflow>/<trigger>` arrives
- **THEN** Caddy SHALL forward the request unchanged to `<app-service>:8080`

#### Scenario: API prefix routes through the catch-all

- **WHEN** a request to `https://<domain>/api/workflows/<tenant>` arrives
- **THEN** Caddy SHALL forward the request to `<app-service>:8080`
- **AND** no auth check SHALL be performed by Caddy

#### Scenario: Unknown path reaches the app

- **WHEN** a request to `https://<domain>/absolutely-nothing` arrives
- **THEN** Caddy SHALL forward the request to `<app-service>:8080`
- **AND** the app's Hono `notFound` handler SHALL produce the response

### Requirement: Caddy network policy

Caddy's pod SHALL be protected by an inline `kubernetes_network_policy_v1` rendered inside `modules/caddy/`. The policy SHALL allow:

- Ingress on TCP `:80` and `:443` from the LoadBalancer source CIDRs (UpCloud LB health-check + traffic source) and from the node CIDR (kubelet probes).
- Egress to the app pod's Service in workload namespaces (`prod`, `staging`, or `workflow-engine` for local) on TCP `:8080`.
- Egress to CoreDNS on TCP/UDP `:53`.
- Egress to the public internet on TCP `:80` (HTTP-01 challenge inbound is handled by ingress; outbound `:80` is for Caddy's ACME client to reach Let's Encrypt API endpoints which are HTTPS, but ACME directories may use HTTP redirects), TCP `:443` (LE API), with the same RFC1918+link-local `except` list applied today to the app pod.

The policy SHALL NOT allow forward-auth to any oauth2-proxy pod (no such workload exists). Authentication is end-to-end in the app.

#### Scenario: LB traffic permitted to Caddy

- **WHEN** a client request reaches the cluster via the UpCloud LB on `:443`
- **THEN** the NetworkPolicy SHALL permit the connection to the Caddy pod

#### Scenario: Caddy egress to app permitted

- **WHEN** Caddy reverse-proxies a request to `<app-service>:8080`
- **THEN** the NetworkPolicy SHALL permit the egress from Caddy to the app pod

#### Scenario: Caddy egress to LE permitted

- **WHEN** Caddy initiates an ACME directory fetch to a Let's Encrypt endpoint on `:443`
- **THEN** the NetworkPolicy SHALL permit the egress (matched by the `0.0.0.0/0` except RFC1918 rule)

### Requirement: App pod NetworkPolicy contract

The app pod SHALL be protected by a `kubernetes_network_policy_v1` rendered inline inside `modules/app-instance/` (no factory module). The policy SHALL deny all inbound and outbound traffic by default (relying on the per-namespace default-deny from `pod-security-baseline` + this allowlist as defence-in-depth) except:

- Ingress from pods in the Caddy namespace (`caddy` in cluster + workload envs; `workflow-engine` namespace in local where Caddy is co-located) on TCP `:8080`.
- Ingress from the node CIDR on TCP `:8080` (kubelet liveness/readiness probes).
- Egress to CoreDNS on TCP/UDP `:53`.
- Egress to the public internet (TCP/UDP `0.0.0.0/0`) except RFC1918 + link-local CIDRs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fe80::/10`, `fd00::/8`). This permits UpCloud Object Storage access (S3 API on `:443`), GitHub API access (`api.github.com:443`), and outbound `fetch()` from sandboxed workflows.

**Local deviation:** the policy SHALL additionally allow egress to the in-cluster S2 (local-S3) Service on TCP `:9000`. This rule is conditional on the `local_deployment` input variable to `modules/app-instance/` and is omitted in the cluster, prod, and staging envs.

The policy SHALL NOT allow forward-auth ingress from any oauth2-proxy pod (no such workload exists). The policy SHALL NOT name `traefik` as an ingress source (no such workload exists post-migration).

The NetworkPolicy is load-bearing as defence-in-depth per `SECURITY.md §5 R-I1`.

#### Scenario: Non-Caddy inbound rejected

- **WHEN** any pod outside the Caddy namespace attempts to connect to the app on `:8080`
- **THEN** the connection SHALL be refused by the NetworkPolicy

#### Scenario: Caddy inbound permitted

- **GIVEN** a request arriving at the app from the Caddy pod via Caddy's `reverse_proxy`
- **WHEN** the app receives the connection on `:8080`
- **THEN** the NetworkPolicy SHALL permit it

#### Scenario: Kubelet probes permitted

- **WHEN** the kubelet on the node sends a liveness or readiness probe to the app on `:8080`
- **THEN** the NetworkPolicy SHALL permit the connection (matched by the node-CIDR rule)

#### Scenario: Local deployment permits S2 egress

- **WHEN** `modules/app-instance/` is instantiated with `local_deployment=true`
- **THEN** the rendered NetworkPolicy SHALL include an egress rule to pods labeled `app.kubernetes.io/name=s2` on TCP `:9000`

#### Scenario: Production deployment omits S2 egress

- **WHEN** `modules/app-instance/` is instantiated with `local_deployment=false` (prod or staging)
- **THEN** the rendered NetworkPolicy SHALL NOT include any egress rule referencing S2

### Requirement: LB hostname discovered via the upcloud provider data source

The cluster project SHALL discover the Caddy LoadBalancer's UpCloud hostname using the `upcloud` provider's load-balancer data source, keyed by the `ccm_cluster_id` label that the UpCloud CCM applies to LBs created by the cluster's K8s service controller. The project SHALL NOT use `data "http"` against `https://api.upcloud.com/1.3/load-balancer`, SHALL NOT call `jsondecode()` to parse load-balancer JSON, and SHALL NOT depend on the `hashicorp/http` provider for this purpose.

#### Scenario: lb_hostname output sourced from upcloud provider

- **WHEN** the cluster project is applied
- **THEN** the `lb_hostname` output SHALL be sourced from the `upcloud` provider's load-balancer data source
- **AND** no `data "http"` block referencing `api.upcloud.com` SHALL be present in the cluster project
- **AND** no `jsondecode` of LB JSON SHALL be present

