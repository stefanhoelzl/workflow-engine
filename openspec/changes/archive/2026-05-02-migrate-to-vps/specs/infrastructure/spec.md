## REMOVED Requirements

The following requirements describe the previous K8s-shaped infrastructure (UpCloud Managed Kubernetes + Caddy as raw `kubernetes_manifest` + UpCloud Object Storage + four-project tofu layout + kind for local dev). They are removed wholesale and replaced by the ADDED requirements below, which describe the new single-VPS shape (Scaleway VPS + Podman + Quadlet + local-disk persistence + single flat tofu project).

A single shared **Reason / Migration** applies to every removed requirement in this section:

- **Reason**: The infrastructure capability's implementation moves from UpCloud K8s + S3 to Scaleway VPS + Podman + Quadlet + local disk. Per the proposal, the capability identity ("production deployment shape") is unchanged; only the implementation changes.
- **Migration**: See the ADDED Requirements section in this delta. The K8s/S3-shaped resources are torn down by the operator post-cutover; there is no rollback. Throwaway data — the existing event store on UpCloud Object Storage is not migrated.

### Requirement: OpenTofu version constraint
### Requirement: Provider version constraints
### Requirement: Local state backend
### Requirement: Module wiring
### Requirement: Non-secret variables in terraform.tfvars
### Requirement: Secret variables in local.secrets.auto.tfvars
### Requirement: URL output
### Requirement: Lock file committed
### Requirement: Gitignore
### Requirement: Kind cluster resource
### Requirement: Image loading into kind cluster
### Requirement: Cluster credential outputs
### Requirement: Cluster name output
### Requirement: UpCloud Kubernetes cluster
### Requirement: Kubernetes version
### Requirement: Kubernetes node group
### Requirement: Ephemeral credential outputs
### Requirement: Kubernetes module output contract
### Requirement: Idempotent image build
### Requirement: Image name output
### Requirement: S2 Deployment
### Requirement: S2 Service
### Requirement: S2 health probe
### Requirement: S3 output contract
### Requirement: UpCloud S3 output contract
### Requirement: UpCloud S3 bucket creation
### Requirement: Scoped service user
### Requirement: Access key generation
### Requirement: App Deployment
### Requirement: App S3 environment variables
### Requirement: App S3 Secret
### Requirement: App health probes
### Requirement: App Service
### Requirement: App workload network allow-rules
### Requirement: Persistence project
### Requirement: S3 configuration from remote state
### Requirement: CI validates all OpenTofu projects
### Requirement: Namespace isolation
### Requirement: Standardized labels
### Requirement: DNS module extraction
### Requirement: Deployment depends on NetworkPolicy
### Requirement: Security context
### Requirement: App module accepts auth_allow input
### Requirement: App module accepts GitHub OAuth App credentials
### Requirement: Cluster module exposes node CIDR
### Requirement: Cluster project composition root
### Requirement: Cluster project outputs
### Requirement: Apps re-fetch kubeconfig via ephemeral block
### Requirement: App project composition root
### Requirement: Prod image identity via digest
### Requirement: Staging image identity via digest
### Requirement: Staging bucket inside staging project
### Requirement: DNS ownership per app project
### Requirement: State key layout
### Requirement: Per-project provider versions
### Requirement: Per-project variables and tfvars
### Requirement: Per-env URL outputs
### Requirement: Drift guard via plan-infra.yml
### Requirement: Helm-rendered-object drift blind spot
### Requirement: auth_allow sourced from GitHub repo variables
### Requirement: Release branch powers automated prod deploys
### Requirement: Staging auto-deploys on push to main
### Requirement: cert-manager Helm chart CRD upgrade caveat
### Requirement: Cert readiness verification
### Requirement: Persistence project generates secrets keypair list
### Requirement: Prod project reads persistence output and creates K8s Secret
### Requirement: Staging and local projects generate own keypairs
### Requirement: App pod env_from references app-secrets-key
### Requirement: Caddy module renders Deployment + Service + ConfigMap + PVC
### Requirement: Caddy serves TLS via HTTP-01 ACME for the configured domain
### Requirement: Caddy reverse-proxies all paths to the app Service
### Requirement: Caddy network policy
### Requirement: App pod NetworkPolicy contract
### Requirement: LB hostname discovered via the upcloud provider data source

## ADDED Requirements

### Requirement: Single flat tofu project at infrastructure/

The repository SHALL contain exactly one OpenTofu project at `infrastructure/` with no `envs/<name>/` subdirectories. The project owns the Scaleway VPS, both app Quadlet units, the Caddy unit, the Caddyfile, the Dynu CNAMEs for prod and staging, and the Scaleway Object Storage bucket reference for state. All operations run as `tofu -chdir=infrastructure {init|plan|apply}`.

#### Scenario: Single project layout

- **WHEN** the repository is inspected after the migration
- **THEN** `infrastructure/main.tf`, `infrastructure/variables.tf`, and `infrastructure/cloud-init.yaml` SHALL exist
- **AND** `infrastructure/envs/` SHALL NOT exist
- **AND** `infrastructure/modules/{kubernetes,object-storage,app-instance,baseline,caddy}/` SHALL NOT exist

### Requirement: Minimum OpenTofu version

The `infrastructure/` project SHALL declare `required_version = ">= 1.11.0"` to ensure clients (operator + CI) use a tofu version that supports the encryption block and current provider features.

#### Scenario: Older tofu refuses to init

- **GIVEN** an operator runs `tofu version` returning `1.10.0`
- **WHEN** they run `tofu -chdir=infrastructure init`
- **THEN** tofu SHALL refuse with a version-constraint error

### Requirement: Tofu state on Scaleway Object Storage

The project SHALL configure the `s3` backend pointing at a Scaleway Object Storage bucket, with a custom `endpoint` (e.g. `https://s3.fr-par.scw.cloud`), `region` set to a Scaleway region, and `skip_credentials_validation = true` and `skip_region_validation = true` (Scaleway is S3-compatible but not AWS). Client-side state encryption SHALL be configured via the `encryption` block using a passphrase from `TF_VAR_state_passphrase` so state at rest never contains unencrypted secrets.

#### Scenario: State backend is reachable

- **GIVEN** valid `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for Scaleway Object Storage
- **WHEN** the operator runs `tofu -chdir=infrastructure init`
- **THEN** init SHALL succeed and acquire a lock against the Scaleway bucket

### Requirement: Single Scaleway VPS

The project SHALL provision exactly one `scaleway_instance_server` resource of type `STARDUST1-S` (or larger; configurable via a variable). The image SHALL be Debian 13 (Trixie) — Debian 12 (Bookworm) ships Podman 4.3.1 which lacks Quadlet (introduced in 4.4); Trixie ships Podman 5.x with Quadlet. A `scaleway_instance_ip` SHALL be attached so the public IP survives stop/start cycles. The root volume SHALL be declared explicitly with `size_in_gb`, `volume_type`, and `delete_on_termination` to avoid `(known after apply)` plan opacity.

#### Scenario: Single VPS exists after apply

- **WHEN** `tofu apply` completes successfully
- **THEN** exactly one Scaleway instance SHALL be running with the configured commercial type and image
- **AND** the instance's image SHALL be `debian_trixie` (or a label that ships Podman ≥ 4.4)

### Requirement: Cloud-init changes force VPS replacement

The project SHALL declare a `terraform_data.cloud_init` resource whose `input` is the sha256 of the rendered cloud-init template content. The `scaleway_instance_server.vps` resource SHALL declare `lifecycle { replace_triggered_by = [terraform_data.cloud_init] }`. Without this, the Scaleway provider would update `user_data` in-place (API-mutable) but cloud-init only runs at first boot — so the new config would never take effect on the existing box. With this rule, any change to the cloud-init template (or its inputs) flips the hash and forces the instance to be replaced.

#### Scenario: Cloud-init edit triggers instance replacement

- **GIVEN** the VPS is provisioned and `cloud-init.yaml` is edited (e.g. a new sysctl, a new package, a sudoers rule change)
- **WHEN** the operator runs `tofu apply`
- **THEN** the plan SHALL show `scaleway_instance_server.vps` being replaced (destroy + create)
- **AND** the new instance SHALL boot with the updated cloud-init payload

### Requirement: Cloud-init bootstraps the box

The Scaleway server SHALL receive a cloud-init `user_data` payload that:

- Creates the `deploy` user with no password and an authorized SSH key from `var.deploy_ssh_public_key`.
- Installs `podman`, `fail2ban`, `unattended-upgrades`, and any other host packages required by `host-security-baseline`.
- Allocates a subuid range for `deploy` in `/etc/subuid` and `/etc/subgid`.
- Writes the sysctl `net.ipv4.ip_unprivileged_port_start=80` to `/etc/sysctl.d/`.
- Configures sshd per the `host-security-baseline` SSH-hardening requirement (non-default port, no root, key-only, AllowUsers deploy).
- Configures the host firewall per `host-security-baseline` (default-deny, allow 80/443/SSH-port).
- Enables `fail2ban.service` with the sshd jail, and `unattended-upgrades.service`.
- Enables `podman-auto-update.timer` (system-wide) AND overrides its `OnUnitActiveSec` to 1 minute.
- Creates `/etc/wfe/` (mode 0700, owner deploy:deploy), `/srv/wfe/prod`, `/srv/wfe/staging`, and `/srv/caddy/data` (modes appropriate to their consumers).
- Creates `/etc/containers/systemd/` and `/etc/caddy/` owned `deploy:deploy` so SSH provisioners can drop Quadlet/Caddyfile content without sudo. Podman reads `/etc/containers/systemd/` as root at boot regardless of dir ownership.
- Sets `DEFAULT_FORWARD_POLICY="ACCEPT"` in `/etc/default/ufw` and `ufw default allow routed` so containers on the Podman bridge can egress (DNS, image pulls, ACME). INPUT remains default-deny per `host-security-baseline`.
- Provisions a 1 GiB swapfile at `/swapfile`, idempotent across reboots, persisted in `/etc/fstab`. Mitigates STARDUST1-S's tight 1 GB physical RAM under transient bursts.
- Includes `deploy` in groups `adm` and `systemd-journal` so the operator can run `journalctl -u wfe-prod` without sudo (sudoers is scoped to systemctl only).

The `wait_cloud_init` `null_resource` SHALL invoke `cloud-init status --wait || [ $? -eq 2 ]` followed by `cloud-init status | grep -q '^status: done$'`. cloud-init exits 2 on any recoverable error (deprecation warnings, Scaleway-Debian-image-specific module noise like missing `cc_refresh_rmc_and_interface`, netplan/openvswitch warnings); these are benign and SHALL NOT block apply. The textual status field is the load-bearing assertion.

#### Scenario: First boot reaches an apply-ready state

- **WHEN** the VPS finishes its first boot
- **THEN** `cloud-init status` SHALL report `done`
- **AND** `systemctl is-enabled podman-auto-update.timer` SHALL print `enabled`
- **AND** `systemctl is-active fail2ban.service` SHALL print `active`
- **AND** `swapon --show` SHALL list `/swapfile`
- **AND** `id deploy` SHALL include `adm` and `systemd-journal` in the groups list

### Requirement: Quadlet units for caddy, wfe-prod, wfe-staging

The project SHALL render three Quadlet `.container` files under `/etc/containers/systemd/` on the VPS (system-mode Quadlet — runs rootful via systemd at boot):

- `caddy.container` referencing the Caddy image, with `Network=host` (Caddy must reach `127.0.0.1:8081/8082` to proxy to the apps; under bridge networking, the container's own loopback would not see those upstreams). `PublishPort=` is therefore omitted (host networking binds 80/443/443/udp directly). Volumes: `/srv/caddy/data:/data:Z`, `/srv/caddy/config:/config:Z`, `/etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro,Z`.
- `wfe-prod.container` referencing `ghcr.io/<owner>/<repo>:release`, with `Label=io.containers.autoupdate=registry`, `PublishPort=127.0.0.1:8081:8080`, `Volume=/srv/wfe/prod:/data:Z,U` (the `:U` flag chowns the bind-mount source to the container's UID 65532 at start so the app can write `/data`), `EnvironmentFile=/etc/wfe/prod.env` (secrets only), and `Environment=` directives for non-secret config (`PERSISTENCE_PATH`, `PORT`, `AUTH_PROVIDER`, `BASE_URL`, `AUTH_ALLOW`). Non-secrets are passed via `Environment=` (each becomes a separate `--env KEY=VALUE` flag) rather than `EnvironmentFile=` because Podman's `--env-file` parser mis-splits comma-bearing values like `AUTH_ALLOW`.
- `wfe-staging.container` referencing `ghcr.io/<owner>/<repo>:main`, identical shape pointing at `/srv/wfe/staging` and host port 8082.

Each file SHALL include `[Install] WantedBy=multi-user.target default.target`.

The provisioner null_resources that lay these units down SHALL:
- depend on `null_resource.wait_cloud_init` (so cloud-init is finished before file writes);
- carry `triggers = { instance = null_resource.wait_cloud_init.id, content = sha256(<rendered template>) }` so VPS replacement (which recreates wait_cloud_init with a new id) cascades through every provisioner — without the `instance` trigger, the dependents would refresh state but never re-run on a fresh box because their content hashes haven't changed;
- write the file via `provisioner "file"` with `content = ...` (non-secret) or `source = ...` (per-env secret env files);
- run `sudo systemctl daemon-reload` (in the deploy user's NOPASSWD allowlist) so Quadlet's systemd-generator translates the `.container` file into a transient `.service` unit;
- have `caddy_quadlet` depend on `caddyfile` (the Caddyfile must exist before podman tries to bind-mount it — otherwise podman exits 125);
- delegate the `systemctl restart wfe-<env>` to the env-file provisioner, NOT to the Quadlet provisioner, so the unit is not restarted before its `EnvironmentFile=` resolves.

#### Scenario: All three units start after apply

- **GIVEN** `tofu apply` has completed
- **WHEN** the operator runs `systemctl is-active caddy.service wfe-prod.service wfe-staging.service`
- **THEN** all three SHALL print `active`

#### Scenario: VPS replacement cascades through provisioners

- **GIVEN** `cloud-init.yaml` is edited and tofu applies
- **WHEN** the apply destroys + recreates `scaleway_instance_server.vps`
- **THEN** `null_resource.wait_cloud_init` SHALL be recreated (its `triggers.server_id` changes)
- **AND** every dependent null_resource SHALL also be recreated (their `triggers.instance` references the new wait_cloud_init id)

### Requirement: Tag-based auto-update

Both app Quadlet units SHALL carry `Label=io.containers.autoupdate=registry`. The system-wide `podman-auto-update.timer` SHALL be overridden via a drop-in `/etc/systemd/system/podman-auto-update.timer.d/override.conf` to fire every 1 minute (`OnUnitActiveSec=1min`). Image references in Quadlet files SHALL be tag-based (`:release`, `:main`) and SHALL NOT pin a digest.

#### Scenario: A new image push triggers a restart within 1 minute

- **GIVEN** `wfe-prod.service` is running image `ghcr.io/.../workflow-engine:release@sha256:OLD`
- **AND** a new image is pushed to `ghcr.io/.../workflow-engine:release@sha256:NEW`
- **WHEN** `podman-auto-update.timer` fires (within 60 seconds)
- **THEN** podman SHALL pull `:release@sha256:NEW`
- **AND** `wfe-prod.service` SHALL be restarted on the new image

### Requirement: Caddyfile renders one site block per env

The Caddyfile SHALL be rendered by tofu (via `templatefile()`) with one site block per env:

- `workflow-engine.webredirect.org { tls <acme-email> ; reverse_proxy 127.0.0.1:8081 }`
- `staging.workflow-engine.webredirect.org { tls <acme-email> ; reverse_proxy 127.0.0.1:8082 }`

Caddy's automatic HTTPS SHALL provide HTTP→HTTPS redirect, HSTS, and TLS termination via Let's Encrypt HTTP-01 ACME. ACME state SHALL persist on the host volume mounted at `/data` (i.e. `/srv/caddy/data` on the host).

#### Scenario: Both hostnames serve a publicly-trusted cert

- **GIVEN** the Dynu CNAMEs have propagated to the VPS IP and Caddy has completed ACME
- **WHEN** an external client runs `curl -I https://workflow-engine.webredirect.org` and `curl -I https://staging.workflow-engine.webredirect.org`
- **THEN** both SHALL return `200` (or whatever the app returns) with a valid Let's Encrypt-issued chain

### Requirement: Caddy SHALL NOT enforce authentication

Caddy SHALL act exclusively as TLS termination + reverse proxy + HTTPS redirect. It SHALL NOT mount any authentication module, forward-auth integration, or basic-auth directive. Per-route authentication is owned entirely by the app's `apiAuthMiddleware` and `sessionMiddleware` (see the `auth` capability).

#### Scenario: Caddyfile contains no auth directives

- **WHEN** the rendered Caddyfile is inspected
- **THEN** it SHALL NOT contain `forward_auth`, `basicauth`, `jwt`, or any directive that authenticates incoming requests

### Requirement: Apps bind only to loopback

Each app Quadlet's `PublishPort` SHALL bind only on `127.0.0.1` (`PublishPort=127.0.0.1:<host>:<container>`). This requirement is duplicated in `host-security-baseline` for the security framing; it appears here for the deployment-shape framing.

#### Scenario: Quadlet PublishPort is loopback-scoped

- **WHEN** the rendered `wfe-prod.container` and `wfe-staging.container` are inspected
- **THEN** every `PublishPort=` line SHALL begin with `127.0.0.1:`

### Requirement: Local-disk persistence per env

Each app SHALL run with `PERSISTENCE_PATH=/data` (via Quadlet `Environment=`) and a host bind mount at `/srv/wfe/<env>:/data:Z,U`. The `:U` flag is required: it makes Podman recursively chown the host directory to the container's UID 65532 at start time, otherwise the container process can't write to a host dir initially owned by `deploy`. The two envs SHALL NOT share a persistence directory. The S3 backend env vars (`PERSISTENCE_S3_*`) SHALL NOT be set on the new deployment.

#### Scenario: Per-env directories exist and are isolated

- **GIVEN** the VPS has been provisioned
- **WHEN** the operator inspects `/srv/wfe/`
- **THEN** `prod/` and `staging/` SHALL exist as separate subdirectories
- **AND** each SHALL be owned by UID 65532 (chown'd by Podman's `:U` mount option on first container start)

### Requirement: Per-env secret env files

Per-env env files at `/etc/wfe/<env>.env` SHALL contain ONLY values whose presence in tofu state is an acceptable trade-off (the `encryption {}` block AES-GCM-encrypts state at rest with `var.state_passphrase`). Currently those values are: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SECRETS_PRIVATE_KEYS` (auto-generated; see "Auto-generated workflow-secrets sealing key" below).

The provisioner null_resource SHALL render content inline via `provisioner "file" { content = ... }` from variables sourced from the operator's local secret store (proton-env or equivalent). After copying, a `provisioner "remote-exec"` SHALL `install -m 0600 -o deploy -g deploy` the file into `/etc/wfe/<env>.env` and `sudo systemctl restart wfe-<env>` to pick up changes. The trigger is `sha256(<rendered content>)` so any value change forces re-render + restart.

Non-secret config (`AUTH_ALLOW`, `BASE_URL`, `AUTH_PROVIDER`, `PERSISTENCE_PATH`, `PORT`) SHALL be passed via Quadlet `Environment=` directives, not via the env file. Justification: Podman's `--env-file` parser mis-splits comma-bearing values (notably `AUTH_ALLOW`); `--env KEY=VALUE` (one per `Environment=` directive) is parsed correctly.

The implementation SHALL NOT use `local_file` or `local_sensitive_file` (those leak secrets through additional state attributes beyond the consuming `null_resource`'s trigger).

#### Scenario: A secret rotation triggers a unit restart

- **GIVEN** `TF_VAR_gh_oauth_client_secret_prod` is updated in the operator's secret store
- **WHEN** `tofu apply` is re-run
- **THEN** `local.env_files["prod"]` rendered content differs
- **AND** `triggers.content` (sha256) on `null_resource.wfe_env_file["prod"]` differs
- **AND** tofu re-runs the file + remote-exec provisioners
- **AND** `wfe-prod.service` SHALL be restarted

### Requirement: Auto-generated workflow-secrets sealing key

The project SHALL declare `random_bytes.secrets_key` per env (32 bytes each, base64-encoded). The env file SHALL render `SECRETS_PRIVATE_KEYS=v1:${random_bytes.secrets_key[<env>].base64}` so the runtime's workflow-secrets feature has its sealing key. The key is generated once on first apply and preserved across applies (state-tracked). Rotation: `tofu taint 'random_bytes.secrets_key["<env>"]'` then apply.

Multi-key staged rotation (concurrent decrypt against retired key + seal against new) is NOT supported by this scheme — it would require manual `keyId:base64,keyId:base64` composition. Single-key auto-generation is sufficient until uploaded bundles reference older keyIds.

#### Scenario: Key persists across applies

- **GIVEN** an apply has generated `random_bytes.secrets_key["prod"]`
- **WHEN** a subsequent apply runs without taint
- **THEN** the key value SHALL be unchanged
- **AND** the env file's `SECRETS_PRIVATE_KEYS` line SHALL be byte-identical

### Requirement: Dynu CNAMEs owned by tofu

The project SHALL manage two Dynu CNAME records:

- `workflow-engine.webredirect.org` → VPS public IP (or its DNS name).
- `staging.workflow-engine.webredirect.org` → same.

Records SHALL be created via the existing dynu provider, parameterised by `var.dynu_api_key`. TTL SHALL be small enough (≤ 300 s) that DNS-level corrections during validation propagate quickly.

#### Scenario: CNAMEs resolve to the VPS

- **GIVEN** tofu apply has completed and Dynu propagation has occurred
- **WHEN** `dig workflow-engine.webredirect.org` is run from an external resolver
- **THEN** it SHALL resolve to the Scaleway VPS public IP

### Requirement: Lock file committed and gitignore boundaries

`infrastructure/.terraform.lock.hcl` SHALL be committed. `infrastructure/.terraform/` SHALL be gitignored. The runner-local `/tmp/wfe-secrets/` directory SHALL never be in the repository (created and removed by the GHA workflow).

#### Scenario: Lock file is tracked

- **WHEN** the operator runs `git ls-files infrastructure/`
- **THEN** `.terraform.lock.hcl` SHALL appear

### Requirement: kind-based local env removed

The `infrastructure/envs/local/` directory, the `kind` provider usage, the `pnpm local:up*` scripts, the `local.secrets.auto.tfvars(.example)?` files, and any "Cluster smoke (human)" pattern in CLAUDE.md SHALL all be removed. `pnpm dev` SHALL be the only documented local mode.

#### Scenario: kind is gone from the repo

- **WHEN** the repo is grep'd for `kind` provider, `pnpm local:up`, or `infrastructure/envs/local`
- **THEN** no occurrence SHALL remain
