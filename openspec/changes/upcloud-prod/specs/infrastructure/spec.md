## MODIFIED Requirements

### Requirement: Workflow-engine module composes sub-modules

The `workflow-engine` module SHALL instantiate two sub-modules: `app` and `oauth2-proxy`. It SHALL accept an optional `tls` variable of type `object({ certResolver = string })` defaulting to `null`. It SHALL output `traefik_extra_objects` containing the Middleware and IngressRoute CRD definitions, constructed from `app` and `oauth2-proxy` service names/ports and `var.network`. When `var.tls` is not null, the IngressRoute spec SHALL include a `tls` block with the provided configuration.

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

#### Scenario: TLS disabled (default)

- **WHEN** the module is applied without setting `tls`
- **THEN** the IngressRoute spec SHALL NOT contain a `tls` block

#### Scenario: TLS enabled

- **WHEN** the module is applied with `tls = { certResolver = "letsencrypt" }`
- **THEN** the IngressRoute spec SHALL contain `tls = { certResolver = "letsencrypt" }`

### Requirement: Traefik Helm release

The routing module SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7`. The Helm release SHALL use `traefik_helm_sets` for environment-specific Helm `set` values, `traefik_extra_objects` for CRD objects deployed via the chart's `extraObjects` feature, and an optional `wait` variable (bool, default `false`) controlling whether Helm waits for all resources to be ready.

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

## ADDED Requirements

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

### Requirement: Persistence project

`infrastructure/upcloud/persistence/persistence.tf` SHALL be a standalone OpenTofu project that uses `modules/s3/upcloud/` to create the app bucket and scoped user in a manually-created Object Storage instance. It SHALL accept `service_uuid` and `service_endpoint` as input variables. Its state SHALL use an S3 backend (state bucket, key `persistence`, credentials via `TF_VAR_*` variables).

#### Scenario: Persistence project creates bucket and user

- **WHEN** `tofu apply` is run in `infrastructure/upcloud/persistence/` with a valid `service_uuid`
- **THEN** the app bucket and scoped user SHALL be created via the s3/upcloud module

#### Scenario: Persistence outputs consumed by main project

- **WHEN** the main project reads `terraform_remote_state` with key `persistence`
- **THEN** it SHALL receive `endpoint`, `bucket`, `access_key`, `secret_key`, and `region`

#### Scenario: Cluster destroy does not affect persistence

- **WHEN** `tofu destroy` is run in `infrastructure/upcloud/`
- **THEN** the Object Storage instance, bucket, and data SHALL remain intact

### Requirement: Production composition root

`infrastructure/upcloud/upcloud.tf` SHALL wire modules: `kubernetes/upcloud`, `workflow-engine`, and `routing`. It SHALL use an S3 backend (state bucket, key `upcloud`, credentials from environment variables). The kubernetes and helm providers SHALL be configured from the cluster module's ephemeral credential outputs.

#### Scenario: Single apply deploys production stack

- **WHEN** `tofu apply` is run in `infrastructure/upcloud/` with the persistence project already applied
- **THEN** a K8s cluster SHALL be created
- **AND** the app and oauth2-proxy SHALL be deployed
- **AND** Traefik SHALL be deployed with LoadBalancer service and TLS-ALPN-01
- **AND** the Dynu DNS A record SHALL be created pointing at the LB IP

### Requirement: S3 configuration from remote state

The production composition root SHALL read persistence project outputs via `terraform_remote_state` data source (S3 backend, key `persistence`). The outputs SHALL be passed to the workflow-engine module's `s3` variable.

#### Scenario: S3 config flows from persistence

- **WHEN** `tofu apply` is run
- **THEN** the app SHALL receive S3 credentials scoped to the `workflow-engine` bucket

### Requirement: Container image from ghcr.io

The production composition root SHALL construct the image reference as `ghcr.io/stefanhoelzl/workflow-engine:${var.image_tag}`. The `image_tag` variable SHALL default to `"latest"`. The `image_pull_policy` SHALL be `"IfNotPresent"`.

#### Scenario: Default image tag

- **WHEN** `tofu apply` is run without setting `image_tag`
- **THEN** the app SHALL use `ghcr.io/stefanhoelzl/workflow-engine:latest`

#### Scenario: Pinned image tag

- **WHEN** `tofu apply` is run with `image_tag = "v2026.04.11"`
- **THEN** the app SHALL use `ghcr.io/stefanhoelzl/workflow-engine:v2026.04.11`

### Requirement: Traefik with LoadBalancer and TLS-ALPN-01

The routing module SHALL receive `traefik_helm_sets` configuring: `service.type = LoadBalancer`, Let's Encrypt ACME certificate resolver with TLS-ALPN-01 challenge, PVC for certificate persistence (128Mi), and the ACME email from `var.acme_email`. The `wait` variable SHALL be `true`.

#### Scenario: ACME staging server

- **WHEN** `tofu apply` is run with `letsencrypt_staging = true`
- **THEN** the ACME caServer SHALL be `https://acme-staging-v02.api.letsencrypt.org/directory`

#### Scenario: ACME production server

- **WHEN** `tofu apply` is run with `letsencrypt_staging = false`
- **THEN** the ACME caServer SHALL be `https://acme-v02.api.letsencrypt.org/directory`

### Requirement: Dynu DNS A record

The production composition root SHALL use the `Mastercard/restapi` provider configured with Dynu API v2 (`https://api.dynu.com/v2`). A `restapi_object` data source SHALL look up the domain by name (`var.domain`) using `search_key = "name"`. A `restapi_object` resource SHALL create an A record pointing at the Traefik LoadBalancer's external IP.

#### Scenario: DNS record created

- **WHEN** `tofu apply` completes
- **THEN** an A record SHALL exist for `workflow-engine.webredirect.org` pointing at the LB external IP

### Requirement: LB IP via data source

The production composition root SHALL use a `kubernetes_service_v1` data source with `depends_on` on the routing module to read the Traefik service's external IP after Helm deployment completes (with `wait = true`).

#### Scenario: LB IP available

- **WHEN** `tofu apply` completes
- **THEN** the Traefik service status SHALL include a load balancer ingress IP

### Requirement: Production variables

The production composition root SHALL declare variables: `domain` (string), `zone` (string), `kubernetes_version` (string), `node_plan` (string), `image_tag` (string, default `"latest"`), `letsencrypt_staging` (bool, default `true`), `acme_email` (string), `oauth2_client_id` (string), `oauth2_client_secret` (string, sensitive), `oauth2_github_users` (string), `dynu_api_key` (string, sensitive).

#### Scenario: Secrets in tfvars

- **WHEN** `prod.secrets.auto.tfvars` contains OAuth credentials, ACME email, and Dynu API key
- **THEN** `tofu apply` SHALL use these values without prompting

### Requirement: Production URL output

The production composition root SHALL output `url` as `"https://${var.domain}"` (port is always 443 in production).

#### Scenario: Production URL output

- **WHEN** `tofu apply` completes with `domain = "workflow-engine.webredirect.org"`
- **THEN** the output SHALL include `url = "https://workflow-engine.webredirect.org"`

### Requirement: Production provider versions

The production composition root SHALL declare required providers: `UpCloudLtd/upcloud ~> 5.0`, `hashicorp/kubernetes ~> 3.0`, `hashicorp/helm ~> 3.1`, `hashicorp/random ~> 3.8`, `Mastercard/restapi` (latest).

#### Scenario: Provider versions pinned

- **WHEN** `tofu init` is run
- **THEN** providers SHALL be installed within the declared version constraints

### Requirement: CI validates all OpenTofu projects

The CI workflow SHALL run `tofu init && tofu validate` for `infrastructure/local/`, `infrastructure/upcloud/`, and `infrastructure/upcloud/persistence/`. The `tofu fmt -check -recursive infrastructure/` check SHALL cover all projects.

#### Scenario: All projects validated in CI

- **WHEN** a pull request is opened
- **THEN** `tofu validate` SHALL run for all three OpenTofu projects
- **AND** `tofu fmt -check` SHALL cover all `.tf` files

### Requirement: CLAUDE.md production documentation

CLAUDE.md SHALL include a production deployment section documenting prerequisites, environment variables, deployment procedure, and the two-project deployment order (persistence first, then upcloud).

#### Scenario: Documentation complete

- **WHEN** a developer reads CLAUDE.md
- **THEN** they SHALL find instructions for deploying to UpCloud production
