## ADDED Requirements

### Requirement: Cert-manager module

A new `infrastructure/modules/cert-manager/` module SHALL install jetstack/cert-manager via a pinned Helm chart version. The module SHALL install cert-manager using TWO `helm_release` resources inside the module: (1) the upstream cert-manager chart with `installCRDs = true` and `wait = true`, and (2) a local chart (`extras-chart/` within the module directory) that renders `cert-manager.io/v1` custom resources from a `values.extraObjects` list, with `depends_on` on the first release so CRDs are registered in API discovery before the second release's manifests are rendered and applied. The module SHALL accept inputs `acme_email` (string, default ""), `enable_acme` (bool, default `false`), `enable_selfsigned_ca` (bool, default `false`), and `certificate_requests` (list of `{ name, namespace, secretName, dnsNames }`, default `[]`). All cert-manager custom resources (ClusterIssuers, the CA Certificate if `enable_selfsigned_ca`, and one leaf Certificate per entry in `certificate_requests`) SHALL be emitted via the second release's `extraObjects` values, NOT via `kubernetes_manifest` resources. The module SHALL output the active leaf-issuer name and the primary `helm_release` ID.

#### Scenario: Single tofu apply installs cert-manager and all CRs

- **WHEN** `tofu apply` runs with the module wired
- **THEN** the primary cert-manager Helm release SHALL install CRDs (`installCRDs=true`) and wait for controllers + webhook to be Ready
- **AND** the module-internal extras Helm release SHALL then render and apply all ClusterIssuers, the CA Certificate (if `enable_selfsigned_ca=true`), and leaf Certificates for each `certificate_requests` entry
- **AND** `tofu apply` SHALL succeed in a single invocation on any state (fresh or existing), with no `-target` bootstrap required

#### Scenario: Flags off — platform-only install

- **WHEN** the module is applied with `enable_acme = false`, `enable_selfsigned_ca = false`, and `certificate_requests = []`
- **THEN** cert-manager SHALL be installed
- **AND** the extras release SHALL NOT be created (count-driven absence)
- **AND** no ClusterIssuer, CA Certificate, or leaf Certificate SHALL be emitted

### Requirement: ACME ClusterIssuer for Let's Encrypt production

When `enable_acme = true`, the cert-manager module SHALL include a `letsencrypt-prod` ClusterIssuer in the Helm release's `extraObjects` with ACME server `https://acme-v02.api.letsencrypt.org/directory`, email from `var.acme_email`, and an HTTP-01 solver configured with `ingressClassName: traefik`. No `letsencrypt-staging` ClusterIssuer SHALL be emitted — production-only issuance.

#### Scenario: Issuer present with HTTP-01 solver

- **WHEN** the cert-manager module is applied with `enable_acme = true` and `acme_email = "ops@example.com"`
- **THEN** a ClusterIssuer named `letsencrypt-prod` SHALL exist
- **AND** its ACME server SHALL be `https://acme-v02.api.letsencrypt.org/directory`
- **AND** its registration email SHALL be `ops@example.com`
- **AND** its sole solver SHALL be HTTP-01 with `ingressClassName: traefik`

#### Scenario: No staging issuer

- **WHEN** the cert-manager module is applied with `enable_acme = true`
- **THEN** no ClusterIssuer named `letsencrypt-staging` SHALL exist

### Requirement: Self-signed CA ClusterIssuer chain for local

When `enable_selfsigned_ca = true`, the cert-manager module SHALL include three objects in the Helm release's `extraObjects` forming a CA chain: (1) a `selfsigned-bootstrap` ClusterIssuer of kind `SelfSigned`; (2) a Certificate named `selfsigned-ca` in the cert-manager namespace with `isCA: true`, issued by `selfsigned-bootstrap`, written to the Secret `selfsigned-ca-key-pair`; (3) a `selfsigned-ca` ClusterIssuer of kind `CA` referencing that Secret. Leaf certificates issued from `selfsigned-ca` SHALL chain back to the CA cert.

#### Scenario: CA chain reaches Ready asynchronously

- **WHEN** the cert-manager module is applied with `enable_selfsigned_ca = true`
- **THEN** after Helm install completes, a ClusterIssuer `selfsigned-bootstrap` of kind `SelfSigned` SHALL exist
- **AND** within a few seconds cert-manager SHALL reconcile the `selfsigned-ca` Certificate to `Ready=True`
- **AND** a ClusterIssuer `selfsigned-ca` of kind `CA` SHALL exist referencing the CA Secret

### Requirement: Cert-manager module emits leaf Certificates from certificate_requests

The cert-manager module SHALL, for each entry in `certificate_requests`, emit a `cert-manager.io/v1` Certificate in the Helm release's `extraObjects` with `metadata.name = entry.name`, `metadata.namespace = entry.namespace`, `spec.secretName = entry.secretName`, `spec.dnsNames = entry.dnsNames`, and `spec.issuerRef` referencing the active ClusterIssuer (`letsencrypt-prod` when `enable_acme=true`, `selfsigned-ca` when `enable_selfsigned_ca=true`). If neither flag is true, `certificate_requests` MUST be empty.

#### Scenario: Leaf cert emitted with correct issuer

- **WHEN** the module is applied with `enable_acme = true` and `certificate_requests = [{ name = "workflow-engine", namespace = "default", secretName = "workflow-engine-tls", dnsNames = ["workflow-engine.example.com"] }]`
- **THEN** a Certificate named `workflow-engine` SHALL exist in the `default` namespace
- **AND** its `spec.secretName` SHALL be `workflow-engine-tls`
- **AND** its `spec.dnsNames` SHALL be `["workflow-engine.example.com"]`
- **AND** its `spec.issuerRef.name` SHALL be `letsencrypt-prod`

#### Scenario: Leaf cert uses self-signed CA when configured

- **WHEN** the module is applied with `enable_selfsigned_ca = true` and one entry in `certificate_requests`
- **THEN** the resulting Certificate's `spec.issuerRef.name` SHALL be `selfsigned-ca`
- **AND** the resulting Secret SHALL contain a leaf cert signed by the in-cluster CA

#### Scenario: Issuance is asynchronous

- **WHEN** `tofu apply` returns successfully after installing the cert-manager module with leaf certificate_requests
- **THEN** the `helm_release.cert_manager` Ready condition SHALL indicate cert-manager controllers are running
- **AND** the leaf Certificate's Ready condition MAY still be `Unknown` or `False` briefly while cert-manager reconciles it
- **AND** operators SHALL be able to observe issuance progress via `kubectl get certificate -n <namespace> -w`

### Requirement: HTTP→HTTPS redirect on web entrypoint

The `workflow-engine` module SHALL emit a Traefik `Middleware` of type `redirectScheme` (target scheme `https`, permanent redirect) and a Traefik `IngressRoute` on the `web` entrypoint matching `PathPrefix(\`/\`)` with `priority = 1` using that middleware. The backend service SHALL be `noop@internal`. The catch-all SHALL NOT intercept `/.well-known/acme-challenge/*` (cert-manager's solver Ingress wins on rule specificity) nor the existing `/error` loopback route.

#### Scenario: Plain HTTP gets redirected

- **WHEN** a user sends `GET http://workflow-engine.webredirect.org/anything`
- **THEN** Traefik SHALL respond with a 301 redirect to `https://workflow-engine.webredirect.org/anything`

#### Scenario: ACME challenge path is not redirected

- **WHEN** Let's Encrypt requests `GET http://workflow-engine.webredirect.org/.well-known/acme-challenge/<token>` during issuance
- **THEN** Traefik SHALL route the request to cert-manager's solver Ingress
- **AND** the response SHALL NOT be a redirect

#### Scenario: /error loopback is not redirected

- **WHEN** the server-error middleware makes an internal request to `traefik:80/error`
- **THEN** Traefik SHALL route the request to the inline-error IngressRoute
- **AND** the response SHALL be the inline 5xx HTML page (not a redirect)

## MODIFIED Requirements

### Requirement: Workflow-engine module composes sub-modules

The `workflow-engine` module SHALL instantiate two sub-modules: `app` and `oauth2-proxy`. It SHALL accept an optional `tls` variable of type `object({ secretName = string })` defaulting to `null`. It SHALL output `traefik_extra_objects` containing the Middleware and IngressRoute CRD definitions, constructed from `app` and `oauth2-proxy` service names/ports and `var.network`. When `var.tls` is not null, the IngressRoute spec on `websecure` SHALL include a `tls` block containing `secretName = var.tls.secretName`. The module SHALL also output `cert_request` — a value of type `object({ name, namespace, secretName, dnsNames })` when `var.tls` is not null, else `null` — so the root config can wire it into the cert-manager module's `certificate_requests` input. The `workflow-engine` module SHALL NOT create any `cert-manager.io/v1` resources directly; cert issuance is delegated to the cert-manager module.

#### Scenario: All sub-modules created

- **WHEN** `tofu apply` completes with valid inputs
- **THEN** the app Deployment and Service SHALL exist
- **AND** the oauth2-proxy Deployment and Service SHALL exist

#### Scenario: Extra objects output contains CRDs

- **WHEN** the module is applied
- **THEN** `traefik_extra_objects` SHALL contain an `oauth2-forward-auth` Middleware
- **AND** `traefik_extra_objects` SHALL contain an `oauth2-errors` Middleware
- **AND** `traefik_extra_objects` SHALL contain a `redirect-root` Middleware
- **AND** `traefik_extra_objects` SHALL contain a `redirect-to-https` Middleware
- **AND** `traefik_extra_objects` SHALL contain a `workflow-engine` IngressRoute on `websecure`
- **AND** `traefik_extra_objects` SHALL contain a `redirect-to-https` IngressRoute on `web`

#### Scenario: TLS disabled (default)

- **WHEN** the module is applied without setting `tls`
- **THEN** the IngressRoute spec SHALL NOT contain a `tls` block
- **AND** the `cert_request` output SHALL be `null`

#### Scenario: TLS enabled declares a cert request

- **WHEN** the module is applied with `tls = { secretName = "workflow-engine-tls" }` and `network.domain = "workflow-engine.example.com"`
- **THEN** the IngressRoute spec SHALL contain `tls = { secretName = "workflow-engine-tls" }`
- **AND** the `cert_request` output SHALL be `{ name = "workflow-engine", namespace = "default", secretName = "workflow-engine-tls", dnsNames = ["workflow-engine.example.com"] }`
- **AND** the module SHALL NOT create any `cert-manager.io/v1` resources directly

### Requirement: Traefik with LoadBalancer and TLS-ALPN-01

The routing module SHALL receive `traefik_helm_sets` configuring `service.type = LoadBalancer`, `ports.websecure.expose.default = true`, and `ports.websecure.exposedPort = 443`. The `wait` variable SHALL be `true`. The Helm release SHALL NOT configure any `certificatesResolvers.*` settings (this supersedes the previous TLS-ALPN-01 configuration — TLS is now sourced from K8s Secrets via cert-manager). The Helm release SHALL NOT enable `persistence` or reference any existing PVC. TLS certificates SHALL be sourced exclusively from K8s Secrets referenced by IngressRoute `tls.secretName` fields.

#### Scenario: LoadBalancer service exposed on :443

- **WHEN** `tofu apply` completes
- **THEN** the Traefik service SHALL be of type `LoadBalancer`
- **AND** the service SHALL expose port 443 mapped to the websecure entrypoint

#### Scenario: No ACME resolver configured on Traefik

- **WHEN** the Traefik Helm release is inspected
- **THEN** no `certificatesResolvers` helm values SHALL be set
- **AND** no `persistence.enabled` helm value SHALL be set
- **AND** no `persistence.existingClaim` helm value SHALL be set

#### Scenario: Certs come from Secrets only

- **WHEN** Traefik serves an HTTPS response
- **THEN** the leaf certificate SHALL originate from a K8s Secret referenced by the matching IngressRoute's `tls.secretName` field

### Requirement: Production variables

The production composition root SHALL declare variables: `domain` (string), `image_tag` (string, default `"latest"`), `acme_email` (string), `oauth2_client_id` (string), `oauth2_client_secret` (string, sensitive), `oauth2_github_users` (string), `dynu_api_key` (string, sensitive). The `letsencrypt_staging` variable SHALL NOT be declared — production uses the `letsencrypt-prod` ClusterIssuer exclusively.

#### Scenario: Secrets in tfvars

- **WHEN** `prod.secrets.auto.tfvars` contains OAuth credentials, ACME email, and Dynu API key
- **THEN** `tofu apply` SHALL use these values without prompting

#### Scenario: No letsencrypt_staging variable

- **WHEN** the production composition root is inspected
- **THEN** no variable named `letsencrypt_staging` SHALL be declared

### Requirement: Production composition root

`infrastructure/upcloud/upcloud.tf` SHALL wire modules: `kubernetes/upcloud`, `cert-manager` (with `enable_acme = true`, `enable_selfsigned_ca = false`, `acme_email = var.acme_email`, `certificate_requests = compact([module.workflow_engine.cert_request])`), `workflow-engine` (passing `tls = { secretName = "workflow-engine-tls" }`), and `routing`. It SHALL use an S3 backend (state bucket, key `upcloud`, credentials from environment variables). The kubernetes and helm providers SHALL be configured from the cluster module's ephemeral credential outputs.

#### Scenario: Single apply deploys production stack

- **WHEN** `tofu apply` is run in `infrastructure/upcloud/` with the persistence project already applied
- **THEN** a K8s cluster SHALL be created
- **AND** cert-manager SHALL be installed with the `letsencrypt-prod` ClusterIssuer and the workflow-engine leaf Certificate emitted as Helm extraObjects
- **AND** the app and oauth2-proxy SHALL be deployed
- **AND** Traefik SHALL be deployed with LoadBalancer service reading the cert from the `workflow-engine-tls` Secret once cert-manager finishes issuance
- **AND** the Dynu DNS CNAME record SHALL be created pointing at the LB hostname
- **AND** the apply SHALL succeed in a single command invocation (no `-target` bootstrap)

### Requirement: Module wiring

The local root SHALL instantiate six modules: `kubernetes/kind`, `image/local`, `s3/s2`, `cert-manager` (with `enable_acme = false`, `enable_selfsigned_ca = true`, `certificate_requests = compact([module.workflow_engine.cert_request])`), `workflow-engine` (passing `tls = { secretName = "workflow-engine-tls" }`), and `routing`. The kubernetes and helm providers SHALL be configured from the cluster module's credential outputs. The routing module SHALL receive `traefik_extra_objects` from the workflow-engine module and `traefik_helm_sets` from the root config.

#### Scenario: Single apply creates everything

- **WHEN** `tofu apply` is run on a clean state
- **THEN** a kind cluster SHALL be created
- **AND** the app image SHALL be built and loaded
- **AND** S2, app, and oauth2-proxy SHALL be deployed
- **AND** cert-manager SHALL be installed with the selfsigned CA chain and the workflow-engine leaf Certificate emitted as Helm extraObjects
- **AND** the Traefik Helm release SHALL be deployed with IngressRoute and Middleware CRDs
- **AND** the apply SHALL succeed in a single command invocation (no `-target` bootstrap)

## REMOVED Requirements

### Requirement: Tofu-managed Traefik cert PVC

**Reason**: Replaced by cert-manager. Certificates are now stored as K8s Secrets managed by cert-manager, not `acme.json` on a PVC. The PVC is no longer needed.

**Migration**: Delete the `kubernetes_persistent_volume_claim_v1.traefik_certs` resource from `infrastructure/upcloud/upcloud.tf`. On `tofu apply`, tofu removes the PVC from the cluster. IMPORTANT: the `upcloud-block-storage-standard` StorageClass uses `reclaimPolicy: Retain` (verified on the live cluster — this contradicts the assumption in earlier revisions of this migration note). The bound PersistentVolume therefore transitions to `Released` and is NOT garbage-collected, and the underlying UpCloud block-storage volume is NOT deleted by the CSI driver. One-time manual cleanup: `kubectl delete pv <name>` to remove the Released PV, and delete the orphan disk via the UpCloud console or `upctl storage delete <uuid>`.

### Requirement: Clean destroy of Traefik cert storage

**Reason**: No PVC exists after this change. Cert Secrets are owned by the cert-manager Helm releases and Certificate resources, and are destroyed as part of their normal teardown on `tofu destroy`.

**Migration**: `tofu destroy` tears down the cluster and all K8s resources it contains, including the Secret holding the cert. Any pre-existing block-storage volume from the prior PVC-based design is NOT reclaimed automatically by `tofu destroy` either (same `reclaimPolicy: Retain` behavior). After the cert-manager migration is applied and verified, the operator should manually delete any orphan `pvc-*` disks in the UpCloud console; going forward there are no PVCs to orphan, so no further cleanup is needed.
