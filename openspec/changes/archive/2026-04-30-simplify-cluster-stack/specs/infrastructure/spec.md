## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Provider version constraints

The dev root SHALL declare required providers with version constraints: `tehcyx/kind ~> 0.11`, `hashicorp/kubernetes ~> 3.0`, `hashicorp/random ~> 3.8`, `hashicorp/null ~> 3.2`. The `hashicorp/helm` provider SHALL NOT be declared (no Helm releases exist post-migration).

#### Scenario: Provider versions pinned

- **WHEN** `tofu init` is run
- **THEN** providers SHALL be installed within the declared version constraints
- **AND** exact versions SHALL be recorded in `.terraform.lock.hcl`
- **AND** `hashicorp/helm` SHALL NOT appear in `.terraform.lock.hcl`

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

### Requirement: Deployment depends on NetworkPolicy

Every `kubernetes_deployment_v1` SHALL declare `depends_on` on its inline NetworkPolicy and on the baseline module. This ensures the NP allow-rules are in place before the pod starts, preventing DNS-blocked-at-boot races on CNIs that enforce NetworkPolicy asynchronously.

The dependency SHALL be expressed as `depends_on = [kubernetes_network_policy_v1.<name>, module.baseline]` (no factory-module reference, since `modules/netpol/` is deleted).

#### Scenario: NP exists before pod starts

- **WHEN** `tofu apply` runs on a clean state
- **THEN** the app's inline NetworkPolicy SHALL be created before the app Deployment
- **AND** the Caddy inline NetworkPolicy SHALL be created before the Caddy Deployment
- **AND** the baseline default-deny NetworkPolicy SHALL be created before any workload Deployment

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

## REMOVED Requirements

### Requirement: Traefik Helm release

**Reason**: Traefik is replaced by Caddy. The `modules/traefik/` directory and the `helm_release "traefik"` resource are deleted. Caddy is rendered as raw `kubernetes_manifest` resources by the new `modules/caddy/` module — see `Requirement: Caddy module renders Deployment + Service + ConfigMap + PVC`.

**Migration**: The cluster project's wiring changes from `module "traefik"` to `module "caddy"`. The Caddy module's outputs (Service name, namespace) replace the Traefik module's outputs in any consumer.

### Requirement: Traefik workload network allow-rules

**Reason**: Traefik does not exist post-migration. Caddy's NetworkPolicy is owned by `Requirement: Caddy network policy` and is rendered inline inside `modules/caddy/`.

**Migration**: Caddy's allow-rules are equivalent in spirit (LB ingress, app egress, DNS egress) but expressed for the Caddy pod. The ACME-solver egress rule (TCP `:8089`) is no longer needed because Caddy handles ACME directly via its public-internet egress on `:80`/`:443`.

### Requirement: IngressRoute for routing

**Reason**: `IngressRoute` is a Traefik CRD; with Traefik removed, no `IngressRoute` resources exist. Routing is owned by the Caddyfile (`reverse_proxy` directive) — see `Requirement: Caddy reverse-proxies all paths to the app Service`.

**Migration**: The single catch-all behavior (all paths forwarded to the app on `:8080`) is preserved by Caddy's default `reverse_proxy` semantics. The `redirect-to-https` Middleware is replaced by Caddy's automatic HTTP→HTTPS redirect (the Caddyfile's site address with TLS implies redirect).

### Requirement: Traefik inline-response plugin source committed to repo

**Reason**: The Traefik inline-response plugin was used to render 5xx HTML pages at the gateway. With Traefik removed and the app's `secure-headers.ts` + Hono error handlers owning all response generation, no gateway-side plugin exists. The committed `plugin-<version>.tar.gz` file SHALL be deleted from the repository.

**Migration**: 5xx responses are rendered by the app's Hono `onError` handler. Static error templates (if any) live in `packages/runtime/src/ui/` next to the rest of the UI surface, not in the infrastructure tree.

### Requirement: Routes delivered via per-instance Helm chart

**Reason**: The `modules/app-instance/routes-chart/` Helm sub-chart rendered `IngressRoute` and `Middleware` CRDs. With Caddy's Caddyfile owning routing (cluster-scoped, not per-instance), no per-instance routing chart is needed. The `routes-chart/` directory and the corresponding `helm_release` inside `modules/app-instance/` SHALL be deleted.

**Migration**: Per-instance routing differences (different domains, different upstream Services) are resolved at the cluster scope by the Caddy ConfigMap, which receives the workload's Service reference and domain as module variables. For the multi-tenant cluster + workload-env model, the Caddy ConfigMap may template multiple site blocks (one per upstream); details are an implementation choice inside `modules/caddy/`.

### Requirement: Error page template as file

**Reason**: This requirement existed to deliver an HTML 5xx page to the Traefik inline-response plugin. With Traefik removed, the gateway-side error page is also removed. App-side 5xx rendering is owned by the app's Hono `onError` handler.

**Migration**: The `infrastructure/templates/error-5xx.html` file SHALL be deleted. App-side templates live in `packages/runtime/src/ui/` (or wherever the app's UI templates are colocated; outside the scope of this capability).

### Requirement: cert-manager module scope reduction

**Reason**: cert-manager is replaced by Caddy's built-in ACME client. The `modules/cert-manager/` directory is deleted. No `helm_release` for cert-manager, no `ClusterIssuer`, no `Certificate` CRDs exist post-migration.

**Migration**: The `letsencrypt-prod` ACME issuance path is now Caddy's HTTP-01 ACME (see `Requirement: Caddy serves TLS via HTTP-01 ACME for the configured domain`). The selfsigned-CA bootstrap chain used in the local kind stack is replaced by Caddy's `tls internal` directive (see the same requirement's `**Local deviation:**` clause).

### Requirement: app-instance module creates Certificate and solver NetworkPolicy

**Reason**: With cert-manager removed, no `Certificate` CRD exists. With Caddy handling its own HTTP-01 challenge directly via egress on `:80`, no separate `acme-solver` NetworkPolicy is needed in the app namespace.

**Migration**: The `active_issuer_name` input variable on `modules/app-instance/` is removed. The `cert_manager_ready` and related dependency variables are removed. The `routes-chart` Helm release that previously rendered the Certificate CRD is removed alongside the IngressRoute/Middleware deletions.
