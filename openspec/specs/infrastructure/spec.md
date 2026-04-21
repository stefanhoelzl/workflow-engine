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

The `replicas = 1` invariant is load-bearing for the `auth` capability: the session-cookie sealing password is generated in memory at app startup and is not shared across pods. Running more than one replica would cause deterministic cookie-decryption failures whenever a request lands on a pod other than the one that sealed the cookie. Raising `replicas` above 1 SHALL be blocked by the corresponding `auth` invariant recorded in `/SECURITY.md §5` until the sealing-password strategy is migrated to a shared mechanism (e.g., a K8s Secret or KMS-backed KEK).

#### Scenario: App pod running with a single replica

- **WHEN** `tofu apply` completes
- **THEN** exactly one app pod SHALL be running with the specified image
- **AND** the Deployment's `spec.replicas` SHALL equal 1

#### Scenario: Raising replicas beyond one is blocked by spec invariant

- **GIVEN** a change proposal that sets `spec.replicas > 1` on the app Deployment
- **WHEN** the proposal is reviewed
- **THEN** the proposal SHALL include a migration of the session-cookie sealing password out of in-memory state (recorded in the `auth` capability) before being accepted

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

### Requirement: Traefik Helm release

The routing module SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7`. The Helm release SHALL use `traefik_helm_sets` for environment-specific Helm `set` values, `traefik_extra_objects` for CRD objects deployed via the chart's `extraObjects` feature, and an optional `wait` variable (bool, default `false`) controlling whether Helm waits for all resources to be ready.

The Traefik plugin `traefik_inline_response` SHALL be loaded from a vendored local source tree rather than fetched from GitHub at pod startup. The Helm values SHALL declare `experimental.localPlugins.inline-response` with `moduleName = "github.com/tuxgal/traefik_inline_response"` (no `version` field — `localPlugins` reads from disk). An init container declared via Helm `deployment.initContainers` SHALL extract the plugin tarball (mounted from a ConfigMap as `binary_data`) into an `emptyDir` volume, which is in turn mounted into the main Traefik container at `/plugins-local`. The main container SHALL read the plugin source from the extracted tree.

#### Scenario: Traefik installed via Helm with parameterized config

- **WHEN** `tofu apply` completes
- **THEN** Traefik SHALL be running in the cluster
- **AND** the Helm `set` values SHALL match the provided `traefik_helm_sets`
- **AND** the Helm `extraObjects` SHALL contain the provided `traefik_extra_objects`

#### Scenario: Wait disabled (default)

- **WHEN** `tofu apply` is run with `wait` not set
- **THEN** Helm SHALL not wait for resources to be ready before marking the release as successful

#### Scenario: Wait enabled

- **WHEN** `tofu apply` is run with `wait = true`
- **THEN** Helm SHALL wait for all pods to be ready and LoadBalancer services to receive an external IP before marking the release as successful

#### Scenario: Web entrypoint enabled internally

- **WHEN** the Traefik pod is running
- **THEN** the web entrypoint SHALL listen on port 80 inside the pod
- **AND** the Traefik K8s Service SHALL include port 80
- **AND** no NodePort SHALL be mapped to port 80

#### Scenario: Plugin loaded from vendored source

- **WHEN** the Traefik pod starts
- **THEN** the init container SHALL extract the plugin tarball to the shared `emptyDir`
- **AND** the main Traefik container SHALL load the `traefik_inline_response` plugin from `/plugins-local/src/github.com/tuxgal/traefik_inline_response/`
- **AND** the plugin SHALL be available for middleware configuration
- **AND** no runtime HTTPS request to `github.com` SHALL be made by the Traefik container for plugin loading

<!-- Removed: Traefik inline-response plugin source fetched and vendored at apply time — see archive/2026-04-16-infra-refactor -->

<!-- Removed: Namespace default-deny NetworkPolicy — see archive/2026-04-16-infra-refactor -->

### Requirement: App workload network allow-rules

The `app` submodule SHALL create a `NetworkPolicy` selecting the app Deployment's pods (`podSelector` matching the app's Deployment labels, e.g. `app=workflow-engine`) with `policyTypes: ["Ingress", "Egress"]`. The policy SHALL express:

**Egress allow-rules**:
- `to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] } }]` with no port restriction — covers UpCloud Object Storage, `api.github.com`, and sandboxed-action `__hostFetch` destinations.
- `to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "coredns" } } }]` on `UDP :53` and `TCP :53` — DNS resolution via CoreDNS.

**Ingress allow-rules**:
- `from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } } }]` on `TCP :8080` — only Traefik pods may reach the app's HTTP port.
- `from: [{ ipBlock: { cidr: "172.24.1.0/24" } }]` on `TCP :8080` — node CIDR allows kubelet liveness/readiness probes.

#### Scenario: App reaches UpCloud Object Storage over the public Internet

- **WHEN** the app issues an HTTPS request to `7aqmi.upcloudobjects.com` (public IPs)
- **THEN** the egress ipBlock rule SHALL permit the connection

#### Scenario: App reaches api.github.com for token validation

- **WHEN** the app calls `api.github.com/user` during API auth
- **THEN** the egress ipBlock rule SHALL permit the connection

#### Scenario: App cannot reach cloud metadata endpoint

- **WHEN** a sandboxed action attempts to fetch `http://169.254.169.254/`
- **THEN** the egress ipBlock `except` on `169.254.0.0/16` SHALL cause the packet to be dropped

#### Scenario: App cannot reach other in-cluster pods directly

- **WHEN** a sandboxed action attempts to fetch any in-cluster Service or pod IP (within `10.0.0.0/8` or `172.16.0.0/12`)
- **THEN** the egress ipBlock `except` SHALL cause the packet to be dropped

#### Scenario: App resolves DNS via CoreDNS

- **WHEN** the app resolves a hostname
- **THEN** the egress DNS rule SHALL permit the query to CoreDNS pods in `kube-system`

#### Scenario: Non-Traefik pod cannot reach app:8080

- **WHEN** any pod other than Traefik (for example oauth2-proxy) attempts to connect to the app on `:8080`
- **THEN** the ingress rule restricting to `app.kubernetes.io/name=traefik` SHALL cause the connection to be dropped

#### Scenario: Kubelet probes reach app

- **WHEN** the kubelet (from the node at an IP in `172.24.1.0/24`) issues a readiness or liveness probe to the app's `:8080`
- **THEN** the ingress node-CIDR rule SHALL permit the probe

### Requirement: Traefik workload network allow-rules

The routing module SHALL declare the Traefik NetworkPolicy as a first-class `kubernetes_network_policy_v1` Terraform resource (not via Helm `extraObjects`) and make `helm_release.traefik` explicitly depend on it. This ordering ensures the NP is created and enforced by the CNI before the Traefik pod boots; otherwise ACME resolver initialization can race with NP enforcement and fail to reach Let's Encrypt at startup, leaving the resolver permanently unavailable.

The policy SHALL select pods with label `app.kubernetes.io/name=traefik` and set `policyTypes: ["Ingress", "Egress"]`. It SHALL express:

**Egress allow-rules**:
- `to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] } }]` — covers Let's Encrypt ACME directory endpoints for cert issuance/renewal.
- DNS rule identical to the app workload's (CoreDNS on UDP+TCP `:53`).
- `to: [{ podSelector: { matchLabels: { "app": "workflow-engine" } } }]` on `TCP :8080` — backend to the app.
- `to: [{ podSelector: { matchLabels: { "app": "oauth2-proxy" } } }]` on `TCP :4180` — forward-auth to oauth2-proxy.

**Ingress allow-rules**:
- Node CIDR `172.24.1.0/24` on TCP `:8000` (web entrypoint), `:8443` (websecure entrypoint), `:8080` (admin/ping for kubelet probes). With `externalTrafficPolicy=Cluster`, kube-proxy SNATs external client IP to the receiving node IP before DNAT to the pod, so at the pod's NP enforcement point the source IP is always in the node CIDR. Ports are the pod's internal `containerPort` values (chart convention: service port `:80` → pod port `:8000`, service port `:443` → pod port `:8443`), NOT the service-level `:80`/`:443`. Cilium evaluates NP ports against the post-DNAT destination port on the pod. Cilium additionally treats `ipBlock: 0.0.0.0/0` as the "world" identity which excludes "host"/"remote-node" traffic, so an explicit node CIDR rule is required even though `0.0.0.0/0` would include it in principle.

#### Scenario: Traefik reaches Let's Encrypt for ACME

- **WHEN** Traefik's cert resolver initiates an ACME order against `acme-v02.api.letsencrypt.org` (or staging)
- **THEN** the egress ipBlock rule SHALL permit the connection

#### Scenario: Traefik reaches app backend

- **WHEN** Traefik routes a request to the app's `:8080`
- **THEN** the egress pod-selector rule SHALL permit the connection

#### Scenario: Traefik performs forward-auth against oauth2-proxy

- **WHEN** Traefik makes a forward-auth call to oauth2-proxy on `:4180`
- **THEN** the egress pod-selector rule SHALL permit the connection

#### Scenario: Public traffic reaches Traefik on 443

- **WHEN** an external client connects to the UpCloud LoadBalancer which forwards to Traefik on `:443`
- **THEN** the ingress rule from `0.0.0.0/0` SHALL permit the connection

#### Scenario: Pods cannot reach Traefik admin or dashboard ports

- **WHEN** another pod attempts to connect to Traefik on any port other than `:80` or `:443`
- **THEN** the default-deny SHALL cause the connection to be dropped

### Requirement: Root redirect

The Helm release `extraObjects` SHALL include a Traefik `Middleware` CRD of type `redirectRegex` that redirects requests matching the root path (`/`) to `/trigger`.

#### Scenario: Root path redirects to trigger

- **WHEN** a request matches `Path('/')`
- **THEN** the user SHALL be redirected to `/trigger` with a 302 status

### Requirement: IngressRoute for routing

The routes-chart Helm release's `extraObjects` SHALL include Traefik `IngressRoute` CRDs on the `websecure` entrypoint organized into three categories:

**UI routes** (session-authenticated by the app, no Traefik-level auth middleware):
- `PathPrefix('/dashboard')` routes to app service (with `not-found` and `server-error` middlewares). No forward-auth, no strip-auth-headers.
- `PathPrefix('/trigger')` routes to app service (with `not-found` and `server-error` middlewares). No forward-auth, no strip-auth-headers.
- `PathPrefix('/auth')` routes to app service (with `not-found` and `server-error` middlewares). Covers `/auth/github/login`, `/auth/github/callback`, and `/auth/logout`.

**No-auth whitelist** (public):
- `Path('/')` redirects to `/trigger` (with `redirect-root` middleware).
- `PathPrefix('/static')` routes to app service (no middleware).
- `PathPrefix('/webhooks')` routes to app service (with `server-error` middleware).
- `Path('/livez')` routes to app service (no middleware).

**App-auth** (app validates tokens internally):
- `PathPrefix('/api')` routes to app service (with `server-error` middleware).

**Catch-all** (deny by default):
- `PathPrefix('/')` with low priority routes to app service (with `not-found` middleware).

The `/oauth2/*` IngressRoute SHALL NOT be present. The `oauth2-forward-auth`, `oauth2-errors`, and `strip-auth-headers` Middleware CRDs SHALL NOT be defined or attached to any route.

#### Scenario: Dashboard route has no forward-auth

- **WHEN** a request matches `PathPrefix('/dashboard')`
- **THEN** it SHALL be routed to `app_service:app_port` with only the `not-found` and `server-error` middlewares
- **AND** no `forwardAuth` Middleware SHALL be applied
- **AND** no `X-Auth-Request-*` headers SHALL be set by any middleware

#### Scenario: /auth routes reach the app

- **WHEN** a request matches `PathPrefix('/auth')`
- **THEN** it SHALL be routed to `app_service:app_port`
- **AND** no auth middleware SHALL interpose

#### Scenario: /oauth2 path is not routed

- **WHEN** a request matches `PathPrefix('/oauth2')`
- **THEN** no IngressRoute SHALL match it
- **AND** the catch-all IngressRoute SHALL handle the request with a 404

#### Scenario: API routes without auth middleware

- **WHEN** a request matches `PathPrefix('/api')`
- **THEN** it SHALL be routed to `app_service:app_port` without any auth middleware applied
- **AND** the app's Bearer middleware SHALL perform authentication

#### Scenario: Webhook routes remain public

- **WHEN** a POST to `PathPrefix('/webhooks')` arrives
- **THEN** it SHALL be routed to `app_service:app_port` with only the `server-error` middleware

#### Scenario: Root redirect unchanged

- **WHEN** a request matches `Path('/')`
- **THEN** the user SHALL be redirected to `/trigger` with a 302 status

#### Scenario: Unknown path returns 404

- **WHEN** a request matches no specific route and falls through to the catch-all
- **THEN** the `not-found` middleware SHALL intercept the 404 from the app
- **AND** the response SHALL be the styled 404 page

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

<!-- ═══════════════════════════════════════════════════════ -->
<!-- Production Stack (infrastructure/upcloud/)             -->
<!-- ═══════════════════════════════════════════════════════ -->

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

### Requirement: Container image from ghcr.io

The production composition root SHALL construct the image reference as `ghcr.io/stefanhoelzl/workflow-engine:${var.image_tag}`. The `image_tag` variable SHALL default to `"latest"`. The `image_pull_policy` SHALL be `"IfNotPresent"`.

#### Scenario: Default image tag

- **WHEN** `tofu apply` is run without setting `image_tag`
- **THEN** the app SHALL use `ghcr.io/stefanhoelzl/workflow-engine:latest`

#### Scenario: Pinned image tag

- **WHEN** `tofu apply` is run with `image_tag = "v2026.04.11"`
- **THEN** the app SHALL use `ghcr.io/stefanhoelzl/workflow-engine:v2026.04.11`

### Requirement: Traefik with LoadBalancer and TLS-ALPN-01

The routing module SHALL receive `traefik_helm_sets` configuring: `service.type = LoadBalancer`, Let's Encrypt ACME certificate resolver with TLS-ALPN-01 challenge, `persistence.enabled = true`, `persistence.existingClaim` bound to the tofu-managed `traefik-certs` PVC, and the ACME email from `var.acme_email`. The `wait` variable SHALL be `true`. The Helm chart SHALL NOT create its own PVC (size and storageClass SHALL NOT be set on the Helm release).

#### Scenario: ACME staging server

- **WHEN** `tofu apply` is run with `letsencrypt_staging = true`
- **THEN** the ACME caServer SHALL be `https://acme-staging-v02.api.letsencrypt.org/directory`

#### Scenario: ACME production server

- **WHEN** `tofu apply` is run with `letsencrypt_staging = false`
- **THEN** the ACME caServer SHALL be `https://acme-v02.api.letsencrypt.org/directory`

#### Scenario: Traefik uses tofu-managed cert PVC

- **WHEN** Traefik is deployed
- **THEN** it SHALL mount the `traefik-certs` PVC at `/data` for ACME cert storage
- **AND** the Helm chart SHALL NOT create its own PVC (no keep-policy-annotated PVC exists)

### Requirement: Tofu-managed Traefik cert PVC

The main project SHALL create a `kubernetes_persistent_volume_claim_v1` named `traefik-certs` in namespace `default` with access mode `ReadWriteOnce`, storage class `upcloud-block-storage-standard`, storage request 1 GB, and `wait_until_bound = false`.

#### Scenario: PVC created by tofu

- **WHEN** `tofu apply` is run
- **THEN** a PVC named `traefik-certs` SHALL exist in the `default` namespace
- **AND** its storage class SHALL be `upcloud-block-storage-standard`
- **AND** its size SHALL be 1 GB

#### Scenario: PVC has no keep-policy annotation

- **WHEN** the PVC is inspected
- **THEN** it SHALL NOT have the annotation `helm.sh/resource-policy: keep`

### Requirement: Clean destroy of Traefik cert storage

Running `tofu destroy` on the main project SHALL delete the `traefik-certs` PVC. The CSI driver SHALL automatically delete the underlying PersistentVolume and UpCloud block storage disk as a consequence.

#### Scenario: Destroy removes PVC and disk

- **WHEN** `tofu destroy` completes in `infrastructure/upcloud/`
- **THEN** no `traefik-certs` PVC SHALL exist in the cluster
- **AND** the underlying UpCloud block storage disk SHALL be removed (dynamic provisioning reclaim)

### Requirement: CI validates all OpenTofu projects

The CI workflow SHALL run `tofu init -backend=false && tofu validate` for `infrastructure/envs/local/`, `infrastructure/envs/persistence/`, `infrastructure/envs/cluster/`, `infrastructure/envs/prod/`, and `infrastructure/envs/staging/`. The `tofu fmt -check -recursive infrastructure/` check SHALL cover all projects.

#### Scenario: All projects validated in CI

- **WHEN** a pull request is opened
- **THEN** `tofu validate` SHALL run for all five OpenTofu projects
- **AND** `tofu fmt -check` SHALL cover all `.tf` files

### Requirement: CLAUDE.md production documentation

CLAUDE.md SHALL include a production deployment section documenting prerequisites, per-project environment variables, one-time setup steps, the four-project apply order (persistence → cluster → prod → staging), and the distinction between operator-driven first-time setup and CI-driven ongoing deploys. The subsequent-deploy documentation SHALL describe: (1) staging auto-deploys on push to `main` via `deploy-staging.yml`; (2) prod auto-deploys on push to `release` via `deploy-prod.yml` behind a required-reviewer gate on the `production` GitHub Environment; (3) the `release` branch is the source of truth for what is deployed to prod; (4) rollback = `git revert` on `release` followed by push.

#### Scenario: Documentation complete

- **WHEN** a developer reads CLAUDE.md
- **THEN** they SHALL find the per-project env-var matrix
- **AND** they SHALL find the apply order
- **AND** they SHALL find the staging-via-CI deploy note
- **AND** they SHALL find the prod-via-CI deploy note describing the `release` branch trigger and approval gate
- **AND** they SHALL find the `git revert` rollback instruction
- **AND** they SHALL find an Upgrade Note describing the one-time migration (destroy + rebuild) required to adopt the four-project layout

### Requirement: Namespace isolation

Workloads SHALL be deployed in dedicated namespaces, not `default`:

- App instances: namespace = instance name (`prod` in the prod project, `staging` in the staging project, `workflow-engine` for local)
- Traefik: namespace `traefik` (created by the cluster project's baseline call)
- cert-manager: namespace `cert-manager` (created by the cert-manager Helm chart)

Each app namespace SHALL be created by its own app project's baseline call — not by the cluster project.

#### Scenario: Default namespace is empty in production

- **WHEN** `tofu apply` completes across all prod projects
- **THEN** no application workloads SHALL be running in the `default` namespace

#### Scenario: Traefik in dedicated namespace

- **WHEN** the cluster project's apply completes
- **THEN** the Traefik Helm release SHALL be deployed in namespace `traefik`

#### Scenario: App namespaces created by app projects

- **WHEN** the cluster project is applied before any app project
- **THEN** the `prod` and `staging` namespaces SHALL NOT exist

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

### Requirement: Deployment depends on NetworkPolicy

Every `kubernetes_deployment_v1` SHALL declare `depends_on` on its corresponding NetworkPolicy (via the netpol factory module) and on the baseline module. This ensures the NP allow-rules are in place before the pod starts, preventing DNS-blocked-at-boot races on CNIs that enforce NetworkPolicy asynchronously.

#### Scenario: NP exists before pod starts

- **WHEN** `tofu apply` runs on a clean state
- **THEN** the app's NetworkPolicy SHALL be created before the app Deployment
- **AND** the baseline default-deny NetworkPolicy SHALL be created before any workload Deployment

### Requirement: Persistence project path

The persistence project SHALL live at `infrastructure/envs/persistence/` (moved from `infrastructure/envs/upcloud/persistence/`). Its S3 backend key SHALL remain `persistence`. Module source paths inside the project SHALL be updated to `../../modules/...` (reflecting the one-level-shallower directory depth).

#### Scenario: State continuity after path move

- **WHEN** `tofu init` is run in the new path
- **THEN** it SHALL pull the same state from the S3 backend (key `persistence`)
- **AND** `tofu plan` SHALL show no changes

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

`infrastructure/envs/cluster/` SHALL be an OpenTofu project that wires: `modules/kubernetes/upcloud`, `modules/baseline` (with `namespaces = ["traefik"]`), `modules/traefik`, `modules/cert-manager` (with `enable_acme = true`), and the Traefik LB hostname lookup via `data "http"`. It SHALL NOT instantiate `modules/app-instance`, `modules/dns/dynu`, or leaf `kubernetes_manifest.certificate` resources. It SHALL use an S3 backend with key `cluster`.

#### Scenario: Cluster apply provisions cluster-scoped infrastructure

- **WHEN** `tofu apply` is run in `infrastructure/envs/cluster/`
- **THEN** a K8s cluster SHALL be created on UpCloud
- **AND** the `traefik` namespace SHALL be created with the PSA restricted label
- **AND** the Traefik Helm release SHALL be deployed with a LoadBalancer service
- **AND** cert-manager SHALL be deployed
- **AND** the `letsencrypt-prod` ClusterIssuer SHALL exist
- **AND** no app workloads, app namespaces, or Dynu DNS records SHALL be created

#### Scenario: Cluster is env-agnostic

- **WHEN** the cluster project's `.tf` files are searched for `prod` or `staging`
- **THEN** no substring match SHALL be found
- **AND** the cluster project SHALL be applyable without any knowledge of which app envs consume it

### Requirement: Cluster project outputs

The cluster project SHALL export the following non-sensitive outputs for downstream app projects:

- `cluster_id`: UpCloud Kubernetes cluster UUID
- `lb_hostname`: Traefik LoadBalancer DNS name (from the UpCloud LB API lookup)
- `active_issuer_name`: name of the active cert-manager ClusterIssuer
- `node_cidr`: pass-through from `module.cluster.node_cidr`
- `baseline`: object bundling `rfc1918_except`, `coredns_selector`, `pod_security_context`, `container_security_context`

No sensitive value (kubeconfig, private keys, API tokens) SHALL appear in cluster project outputs.

#### Scenario: Apps can read cluster outputs

- **WHEN** an app project declares `data "terraform_remote_state" "cluster"` pointing at state key `cluster`
- **THEN** it SHALL be able to read `cluster_id`, `lb_hostname`, `active_issuer_name`, `node_cidr`, and `baseline`

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

Each app project (`envs/prod/`, `envs/staging/`) SHALL wire: `data "terraform_remote_state" "cluster"`, an `ephemeral "upcloud_kubernetes_cluster"` block, `modules/baseline` (with its own `namespaces = [var.namespace]`), a `kubernetes_manifest` Certificate, a `kubernetes_network_policy_v1` for the acme-solver ingress, `modules/app-instance`, and `modules/dns/dynu`. It SHALL use an S3 backend with key `prod` or `staging` respectively.

#### Scenario: Prod apply deploys app in prod namespace

- **WHEN** `tofu apply` is run in `envs/prod/`
- **THEN** the `prod` namespace SHALL be created with the PSA restricted label
- **AND** a default-deny NetworkPolicy SHALL be created in the `prod` namespace
- **AND** a Certificate resource SHALL be created in the `prod` namespace referencing the `letsencrypt-prod` ClusterIssuer
- **AND** the acme-solver ingress NetworkPolicy SHALL exist in the `prod` namespace
- **AND** the app Deployment, Service, oauth2-proxy, and IngressRoute SHALL be deployed in `prod`
- **AND** a Dynu CNAME record SHALL point the prod domain at the cluster LB hostname

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

### Requirement: cert-manager module scope reduction

`modules/cert-manager/` SHALL NOT accept `certificate_requests` as an input. It SHALL NOT emit any leaf `Certificate` resources. It SHALL NOT create any `kubernetes_network_policy_v1.acme_solver_ingress` resources. It SHALL retain the `helm_release "cert_manager_extras"` wrapper to work around plan-time CRD discovery, but its chart values SHALL render only cluster-scoped issuer objects — the ACME `letsencrypt-prod` ClusterIssuer when `enable_acme` is true, or the selfsigned bootstrap → CA → CA-issuer chain when `enable_selfsigned_ca` is true. The module SHALL output `active_issuer_name`.

#### Scenario: Module emits only chart and issuers

- **WHEN** `tofu plan` is inspected in a fresh cluster project with `enable_acme = true`
- **THEN** the cert-manager module's managed resources SHALL include: the cert-manager `helm_release`, and the `helm_release "cert_manager_extras"` whose values render exactly one ClusterIssuer (`letsencrypt-prod`)
- **AND** no leaf Certificate, acme-solver NetworkPolicy SHALL be managed by the module

#### Scenario: Selfsigned bootstrap chain for local env

- **WHEN** the cert-manager module is applied with `enable_selfsigned_ca = true`
- **THEN** the extras-chart SHALL render the selfsigned bootstrap ClusterIssuer, the selfsigned CA Certificate, and the selfsigned CA ClusterIssuer
- **AND** the module SHALL output `active_issuer_name = "selfsigned-ca"`

### Requirement: app-instance module creates Certificate and solver NetworkPolicy

`modules/app-instance/` SHALL accept `active_issuer_name` as an input and pass it to the existing `helm_release "routes"` as a chart value (alongside `tlsSecretName`). The chart (`modules/app-instance/routes-chart/`) SHALL render a `cert-manager.io/v1` `Certificate` resource when both values are set, with `spec.dnsNames = [<domain value>]`, `spec.secretName = <tlsSecretName>`, and `spec.issuerRef = { name = <certIssuerName>, kind = "ClusterIssuer", group = "cert-manager.io" }`. Delivering the Certificate via the chart avoids plan-time CRD discovery.

Additionally, `modules/app-instance/` SHALL create a plain `kubernetes_network_policy_v1` in `var.namespace` selecting pods with label `acme.cert-manager.io/http01-solver = "true"` and allowing ingress from Traefik on TCP/8089. This is a core-API resource (not a CRD) and does not require Helm delivery.

#### Scenario: Routes-chart emits Certificate when inputs are set

- **WHEN** `tofu apply` is run in an app project with `active_issuer_name` set and `tls.secretName` set
- **THEN** the routes helm_release SHALL render a `Certificate` resource in the app's namespace
- **AND** cert-manager SHALL issue a TLS secret within 90 seconds (assuming port 80 reachability)

#### Scenario: App-instance emits solver NetworkPolicy

- **WHEN** `tofu apply` is run in an app project
- **THEN** a NetworkPolicy `allow-ingress-to-acme-solver` SHALL exist in the app's namespace
- **AND** it SHALL permit ingress from Traefik pods to acme-solver pods on TCP/8089

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
- cluster: `UpCloudLtd/upcloud ~> 5.0`, `hashicorp/kubernetes ~> 3.0`, `hashicorp/helm ~> 3.1`, `hashicorp/random ~> 3.8`, `Mastercard/restapi`, `hashicorp/http ~> 3.5`, `hashicorp/local ~> 2.5`
- prod: `UpCloudLtd/upcloud ~> 5.0`, `hashicorp/kubernetes ~> 3.0`, `hashicorp/helm ~> 3.1`, `Mastercard/restapi`
- staging: same as prod

#### Scenario: Tofu init resolves providers per project

- **WHEN** `tofu init` is run in any project
- **THEN** only that project's declared providers SHALL be downloaded into its `.terraform/` directory

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

