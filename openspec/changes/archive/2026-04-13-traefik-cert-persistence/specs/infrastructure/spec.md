## MODIFIED Requirements

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

## ADDED Requirements

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
