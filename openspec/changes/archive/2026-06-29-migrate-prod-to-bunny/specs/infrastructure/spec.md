## ADDED Requirements

### Requirement: Bunny Edge Storage zones for bundle storage

The `infrastructure/` project SHALL declare one `bunnynet_storage_zone` resource **per env** (`staging`, `prod`) for workflow bundle storage, each with its main storage region set to Frankfurt (DE) to match that env's Magic Containers region. Both envs run on the Bunny Edge Storage (`bunny`) backend; there is no local-disk (`fs`) backend in use anywhere, the VPS having been retired. Each env's zone SHALL be dedicated to that env's bundles; staging and prod SHALL NOT share a zone.

Each zone's read-write access key SHALL be sourced from the resource's own `password` attribute and threaded directly into that env's Magic Containers app env (see the `bunny-deployment` capability) — no new `TF_VAR_*` input or GHA secret SHALL be introduced for it. Because the `bunnynet` provider marks the zone `password` attribute sensitive, it SHALL NOT appear in the `plan-infra` step summary.

Provisioning the zones is operator-driven via the `apply-infra` workflow; agents SHALL NOT run `tofu apply`. The `plan-infra` empty-plan gate SHALL hold once the operator has applied.

#### Scenario: One Frankfurt storage zone per env

- **WHEN** the operator inspects the planned infrastructure
- **THEN** there SHALL be exactly one `bunnynet_storage_zone` per env (`staging`, `prod`), each with its main region set to Frankfurt (DE)

#### Scenario: Access key flows from the zone resource, not a new secret input

- **WHEN** the repository and tofu variables are inspected
- **THEN** each env app's Bunny access key SHALL be wired from that env's `bunnynet_storage_zone.password`
- **AND** there SHALL NOT be a new `TF_VAR_*` input or GHA secret declared for any storage-zone access key

#### Scenario: Access key does not leak into the plan-infra step summary

- **WHEN** `plan-infra` renders the plan into `$GITHUB_STEP_SUMMARY`
- **THEN** every storage-zone access key SHALL appear as a sensitive/redacted value, not in cleartext

## MODIFIED Requirements

### Requirement: Single flat tofu project at infrastructure/

The repository SHALL contain exactly one OpenTofu project at `infrastructure/` with no `envs/<name>/` subdirectories. The project owns the env-keyed bunny.net deployment for both `staging` and `prod` (see the `bunny-deployment` capability), the Bunny DNS records (both CNAMEs to Bunny), and the Scaleway Object Storage bucket reference for state. There is NO Scaleway VPS, no app Quadlet unit, no Caddy unit, no Caddyfile, and no cloud-init. All operations run as `tofu -chdir=infrastructure {init|plan|apply}`.

#### Scenario: Single project layout

- **WHEN** the repository is inspected after the migration
- **THEN** `infrastructure/main.tf` and `infrastructure/variables.tf` SHALL exist
- **AND** `infrastructure/envs/` SHALL NOT exist
- **AND** `infrastructure/cloud-init.yaml`, `infrastructure/host.tf`, `infrastructure/apps.tf`, and `infrastructure/caddy.tf` SHALL NOT exist
- **AND** `infrastructure/modules/{kubernetes,object-storage,app-instance,baseline,caddy}/` SHALL NOT exist

### Requirement: Bunny DNS records owned by tofu

The project SHALL manage exactly two DNS records under the `stho.net` zone via the `bunnynet` provider. The zone SHALL be referenced through a `data "bunnynet_dns_zone"` lookup (read-only); the project SHALL NOT own or create the `stho.net` zone, its apex, or any record other than the two below.

- `workflow-engine.stho.net` → **CNAME** to the prod Bunny Magic Containers CDN endpoint host (`*.b-cdn.net`).
- `staging.workflow-engine.stho.net` → **CNAME** to the staging Bunny Magic Containers CDN endpoint host (`*.b-cdn.net`).

Both records SHALL set `ttl = 300`. Each env's `BASE_URL` and its `bunnynet_pullzone_hostname` SHALL use the same `base_domain`-composed hostname. The project SHALL NOT reference the Scaleway VPS IP, the Dynu API, the `restapi` provider, `var.dynu_api_key`, or any `staging_backend`/VPS toggle variable. Because Bunny issues each managed cert only once its CNAME resolves to Bunny, the record for an env SHALL be created and propagated before the apply that validates that env's custom hostname (two-step targeted apply).

#### Scenario: Prod hostname resolves to the Bunny CDN endpoint

- **GIVEN** tofu apply has completed and Bunny DNS propagation has occurred
- **WHEN** `dig workflow-engine.stho.net` is run from an external resolver
- **THEN** it SHALL resolve (via CNAME) to the prod Bunny Magic Containers CDN endpoint host

#### Scenario: Staging hostname resolves to the Bunny CDN endpoint

- **GIVEN** tofu apply has completed and Bunny DNS propagation has occurred
- **WHEN** `dig staging.workflow-engine.stho.net` is run from an external resolver
- **THEN** it SHALL resolve (via CNAME) to the staging Bunny Magic Containers CDN endpoint host

#### Scenario: No VPS / Dynu / restapi reference remains

- **WHEN** the rendered `infrastructure/` project and its `.terraform.lock.hcl` are inspected
- **THEN** there SHALL be no `scaleway_instance_ip` reference in the DNS records, no `restapi` provider, no `Mastercard/restapi` lockfile entry, and no `var.dynu_api_key` reference

#### Scenario: tofu does not own the stho.net zone

- **WHEN** the DNS configuration is inspected
- **THEN** the `stho.net` zone SHALL be referenced via a `data "bunnynet_dns_zone"` source (not a `resource`)
- **AND** only the two `workflow-engine` subdomain records SHALL be managed; the apex and any sibling records SHALL NOT appear in the plan

## REMOVED Requirements

### Requirement: Bunny Edge Storage zone for staging bundles

**Reason**: Renamed and generalized to "Bunny Edge Storage zones for bundle storage" (now in ADDED) — both staging AND prod run on the Bunny Edge Storage backend with their own per-env zone; the singular staging-only requirement no longer reflects reality.

**Migration**: See the ADDED requirement "Bunny Edge Storage zones for bundle storage" and the `bunny-deployment` capability.

### Requirement: Single Scaleway VPS

**Reason**: The Scaleway VPS is retired completely in this change; prod runs on bunny.net Magic Containers alongside staging. There is no instance, IP, or security group.

**Migration**: The application deployment is described by the `bunny-deployment` capability. The tofu `state` backend stays on Scaleway Object Storage (unchanged), independent of the removed compute.

### Requirement: Host configuration converges in place

**Reason**: In-place host convergence (the `managed_users`/`managed_dirs`/`managed_files`/`managed_exec`/`managed_ufw` staged null_resource pipeline over SSH) only exists because there is a host to converge. bunny.net owns the host; there is no SSH convergence.

**Migration**: None. Per-env container config is delivered as platform env vars (see `bunny-deployment`).

### Requirement: Managed user accounts

**Reason**: Per-tenant `wfe-*` and `caddy` host users with subuid ranges exist only on the VPS. bunny.net runs the container; there are no host user accounts to manage.

**Migration**: None.

### Requirement: Cloud-init bootstraps the box

**Reason**: Cloud-init bootstrap (deploy user, sudoers, sshd port, ufw baseline, FORWARD policy) is VPS-only. There is no box to bootstrap.

**Migration**: None.

### Requirement: Quadlet units for caddy and wfe-prod

**Reason**: rootless Podman + systemd Quadlet units are the VPS app-hosting mechanism. bunny.net Magic Containers hosts the container; there are no Quadlet units.

**Migration**: The app-hosting contract is the `bunnynet_compute_container_app` per env in the `bunny-deployment` capability.

### Requirement: Tag-based auto-update

**Reason**: The `podman-auto-update.timer` pulling a moving tag is the VPS deploy mechanism. It does not exist on bunny.net.

**Migration**: Each env's deploy rolls the Bunny app forward by image digest (see `bunny-deployment` and the `ci-workflow` capability).

### Requirement: Caddyfile renders one site block per env

**Reason**: Caddy is removed with the VPS; TLS termination and routing are provided by each env's Bunny CDN endpoint.

**Migration**: Managed HTTPS via the per-env CDN endpoint + `bunnynet_pullzone_hostname` in the `bunny-deployment` capability.

### Requirement: Caddy SHALL NOT enforce authentication

**Reason**: Caddy is removed. The invariant that the edge performs no authentication is preserved by the Bunny CDN, which is a pure TLS/CDN layer; all auth remains in the app (`auth/spec.md`, `SECURITY.md §3`).

**Migration**: The edge-does-no-auth posture now applies to the Bunny CDN endpoint (`bunny-deployment`); `SECURITY.md §3` and `auth/spec.md` cross-references are updated to point at `bunny-deployment` instead of Caddy.

### Requirement: Apps bind only to loopback

**Reason**: Loopback-only binds + Caddy reverse-proxy is the VPS topology. On bunny.net the platform routes the CDN endpoint to the container port directly; there is no host loopback boundary.

**Migration**: None; the container listens on its port and bunny.net fronts it.

### Requirement: Local-disk persistence per env

**Reason**: Local-disk `events.db` + bundle tree on a host bind mount is the VPS persistence model. Both stores are now remote (Bunny Database + Bunny Edge Storage); the container is stateless.

**Migration**: See `bunny-deployment` (remote `DATABASE_URL` + `STORAGE_BACKEND=bunny`) and the per-env storage-zone/database requirements.

### Requirement: Per-env secret env files

**Reason**: `/etc/wfe/<env>.env` host files (mode 0600, on-change restart) deliver secrets only on the VPS. bunny.net has no host filesystem; secrets are platform env vars.

**Migration**: Per-env secrets as plaintext platform env (see `bunny-deployment`), encrypted at rest only in tofu state.

### Requirement: Auto-generated workflow-secrets sealing key

**Reason**: The `random_bytes.secrets_key` map keyed over `local.envs` is tied to the VPS env model. Sealing keys are now per-env standalone resources in the Bunny config.

**Migration**: See `bunny-deployment` "Per-env workflow-secrets sealing key". The existing prod key value is preserved across the refactor via a `moved {}` block (no author re-upload).

### Requirement: Daily disk cleanup service

**Reason**: A host timer trimming disk usage exists only because the VPS has a local disk to fill. The Bunny container is stateless.

**Migration**: None. Bunny Database growth is bounded by the runtime's `EVENT_STORE_RETENTION_DAYS` pruning.

### Requirement: Per-env persistence on dedicated block volumes

**Reason**: Scaleway Block Storage volumes (with `prevent_destroy`, format/mount systemd units) are the VPS durable-data mechanism. They are destroyed with the VPS in this change.

**Migration**: Durability is provided by the managed Bunny Database + Bunny Edge Storage zone (see `bunny-deployment`); the prod volume's data is migrated to those stores before teardown.

### Requirement: Swap activated via a systemd .swap unit

**Reason**: A host swapfile only exists on the VPS. There is no host to configure swap on.

**Migration**: None. Per-container memory is bounded by the Bunny app's resource configuration.
