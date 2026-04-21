## ADDED Requirements

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

### Requirement: Prod image identity via tag

The prod project SHALL declare `variable image_tag { type = string }` and construct the container image reference as `"ghcr.io/stefanhoelzl/workflow-engine:${var.image_tag}"`. It SHALL pass `image_hash = var.image_tag` to the `app-instance` module. The operator SHALL update `image_tag` in `prod/terraform.tfvars` to deploy a new prod image.

#### Scenario: Prod image pinned by tag

- **WHEN** the prod project has `image_tag = "v2026.04.20"` in its tfvars
- **THEN** the prod Deployment's container image SHALL be `ghcr.io/stefanhoelzl/workflow-engine:v2026.04.20`

#### Scenario: Bumping tag triggers rollout

- **WHEN** `image_tag` is changed from `"v2026.04.19"` to `"v2026.04.20"` and `tofu apply` runs
- **THEN** the Deployment's pod template annotation `sha256/image` SHALL change
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

Each project SHALL declare only the variables it uses. Non-secret values SHALL live in the project's `terraform.tfvars`; secrets SHALL be supplied via `TF_VAR_*` environment variables.

- cluster tfvars: `acme_email`
- prod tfvars: `domain`, `oauth2_github_users`, `image_tag`
- staging tfvars: `domain`, `oauth2_github_users`, `service_uuid`, `service_endpoint`, `bucket_name`

#### Scenario: Prod tfvars does not reference cluster state passphrase

- **WHEN** `prod/terraform.tfvars` is read
- **THEN** it SHALL contain `domain`, `oauth2_github_users`, and `image_tag`
- **AND** it SHALL NOT contain `state_passphrase`, `upcloud_token`, `dynu_api_key`, `oauth2_client_id`, or `oauth2_client_secret`

### Requirement: Per-env URL outputs

Each app project SHALL output `url = "https://${var.domain}"`. The cluster project SHALL NOT output a URL (it does not serve user traffic).

#### Scenario: Prod outputs its URL

- **WHEN** `tofu apply` completes in `envs/prod/`
- **THEN** the output SHALL include `url = "https://workflow-engine.webredirect.org"`

#### Scenario: Staging outputs its URL

- **WHEN** `tofu apply` completes in `envs/staging/`
- **THEN** the output SHALL include `url = "https://staging.workflow-engine.webredirect.org"`

## MODIFIED Requirements

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

### Requirement: Persistence project path

The persistence project SHALL live at `infrastructure/envs/persistence/` (moved from `infrastructure/envs/upcloud/persistence/`). Its S3 backend key SHALL remain `persistence`. Module source paths inside the project SHALL be updated to `../../modules/...` (reflecting the one-level-shallower directory depth).

#### Scenario: State continuity after path move

- **WHEN** `tofu init` is run in the new path
- **THEN** it SHALL pull the same state from the S3 backend (key `persistence`)
- **AND** `tofu plan` SHALL show no changes

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

### Requirement: CLAUDE.md production documentation

CLAUDE.md SHALL include a production deployment section documenting prerequisites, per-project environment variables, one-time setup steps, the four-project apply order (persistence → cluster → prod → staging), and the distinction between operator-driven prod deploys and CI-driven staging deploys.

#### Scenario: Documentation complete

- **WHEN** a developer reads CLAUDE.md
- **THEN** they SHALL find the per-project env-var matrix
- **AND** they SHALL find the apply order
- **AND** they SHALL find the staging-via-CI deploy note
- **AND** they SHALL find an Upgrade Note describing the one-time migration (destroy + rebuild) required to adopt this layout

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

## REMOVED Requirements

### Requirement: Staging bucket in cluster state

**Reason**: The cluster project no longer knows about app instances. Staging bucket ownership moves into the staging project so its lifecycle is coupled to the staging env it serves.

**Migration**: Any pre-existing staging bucket reference (there is none in current prod state — staging has never been deployed via the `local.instances` map) is obsolete. New staging bucket is created as part of `envs/staging/`'s first apply.

### Requirement: Multi-instance support via for_each

**Reason**: Per-env projects replace the `for_each` pattern. Each app env has its own composition root and state, enabling independent apply cadence.

**Migration**: The `local.instances` map is deleted from the cluster project. Each instance becomes its own project under `envs/`. Adding a third env (e.g. review) is a copy of `envs/staging/` to a new directory, not a new entry in a map.

### Requirement: Production composition root

**Reason**: The single "production composition root" at `envs/upcloud/cluster/` is replaced by three composition roots: `envs/cluster/` (cluster-scoped infrastructure), `envs/prod/`, and `envs/staging/`. Their contracts are covered by the new requirements "Cluster project composition root" and "App project composition root" in this change.

**Migration**: See the one-time migration procedure documented in CLAUDE.md (destroy old project, delete state key `upcloud`, apply new projects from zero). Persistence bucket + data are unaffected.

### Requirement: Dynu DNS A record

**Reason**: DNS ownership moves into each app project via `modules/dns/dynu/`. The original requirement also described an A record, but the current code emits CNAME records; the new per-app DNS ownership requirement makes this explicit.

**Migration**: After the one-time migration, each app project owns its own CNAME record via `modules/dns/dynu/`. The old cluster-owned record is destroyed as part of the `tofu destroy` in the old project.

### Requirement: LB IP via data source

**Reason**: The cluster project now exposes the LB hostname as the `lb_hostname` output (sourced from the UpCloud LB API via `data "http"`), not via a `kubernetes_service_v1` data source. App projects consume it via `data "terraform_remote_state" "cluster"`.

**Migration**: The `data "http" "traefik_lb"` lookup stays in the cluster project; its value is exposed as the `lb_hostname` output and read by app projects via remote_state.

### Requirement: Production variables

**Reason**: Variables are distributed across projects. See the new requirement "Per-project variables and tfvars" in this change.

**Migration**: Each existing `TF_VAR_*` / tfvar entry maps to the project that now owns it (see CLAUDE.md production section).

### Requirement: Production URL output

**Reason**: URL outputs are per-app-project now (prod and staging each output their own URL). Cluster has no URL. Covered by the new "Per-env URL outputs" requirement.

**Migration**: Operators who previously read `tofu output url` from the cluster project SHALL read it from the relevant app project instead.

### Requirement: Production provider versions

**Reason**: Provider-version declarations are per-project and do not all match anymore. Covered by the new "Per-project provider versions" requirement.

**Migration**: Each project declares only the providers it uses.
