<!-- ═══════════════════════════════════════════════════════ -->
<!-- Local Stack (infrastructure/local/)                    -->
<!-- ═══════════════════════════════════════════════════════ -->

## Purpose

Reusable Terraform modules for the local (kind) and production (UpCloud) stacks.
## Requirements
### Requirement: Single flat tofu project at infrastructure/

The repository SHALL contain exactly one OpenTofu project at `infrastructure/` with no `envs/<name>/` subdirectories. The project owns the Scaleway VPS, both app Quadlet units, the Caddy unit, the Caddyfile, the Dynu CNAMEs for prod and staging, and the Scaleway Object Storage bucket reference for state. All operations run as `tofu -chdir=infrastructure {init|plan|apply}`.

#### Scenario: Single project layout

- **WHEN** the repository is inspected after the migration
- **THEN** `infrastructure/main.tf`, `infrastructure/variables.tf`, and `infrastructure/cloud-init.yaml` SHALL exist
- **AND** `infrastructure/envs/` SHALL NOT exist
- **AND** `infrastructure/modules/{kubernetes,object-storage,app-instance,baseline,caddy}/` SHALL NOT exist

### Requirement: Pinned OpenTofu version

The `infrastructure/` project SHALL declare an exact-patch `required_version` (e.g. `"1.11.6"`, not a range) so all clients — operator local + every CI job invoking `tofu` — resolve the same version. The pin is required because `tofu init` writes version-specific `h1:` hashes into `.terraform.lock.hcl`, and the repo's lockfile-drift gate (`git diff --exit-code infrastructure/.terraform.lock.hcl` in `ci.yml`) fails when CI's `tofu init` produces a different set of hashes than the operator's last commit.

The CI jobs that invoke `tofu` (`ci.yml`, `plan-infra.yml`) SHALL set `opentofu/setup-opentofu`'s `tofu_version` input to the same exact value declared in `required_version`. Bumping the pinned version SHALL update both `infrastructure/main.tf` and every `setup-opentofu` invocation in the same PR.

#### Scenario: Wrong-version tofu refuses to init

- **GIVEN** an operator runs `tofu version` returning a version that does not exactly match `required_version` (e.g. `1.10.0` or `1.12.0` against a pin of `1.11.6`)
- **WHEN** they run `tofu -chdir=infrastructure init`
- **THEN** tofu SHALL refuse with a version-constraint error

#### Scenario: CI tofu matches the pin

- **WHEN** the rendered `.github/workflows/ci.yml` and `.github/workflows/plan-infra.yml` are inspected
- **THEN** every `opentofu/setup-opentofu@v*` step SHALL set `with.tofu_version` to a literal version string
- **AND** that string SHALL equal `infrastructure/main.tf#required_version`

### Requirement: Tofu state on Scaleway Object Storage

The project SHALL configure the `s3` backend pointing at a Scaleway Object Storage bucket, with a custom `endpoint` (e.g. `https://s3.fr-par.scw.cloud`), `region` set to a Scaleway region, and `skip_credentials_validation = true` and `skip_region_validation = true` (Scaleway is S3-compatible but not AWS). Client-side state encryption SHALL be configured via the `encryption` block using a passphrase from `TF_VAR_state_passphrase` so state at rest never contains unencrypted secrets.

#### Scenario: State backend is reachable

- **GIVEN** valid `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for Scaleway Object Storage
- **WHEN** the operator runs `tofu -chdir=infrastructure init`
- **THEN** init SHALL succeed and acquire a lock against the Scaleway bucket

### Requirement: Single Scaleway VPS

The project SHALL provision exactly one `scaleway_instance_server` resource of type `STARDUST1-S` (or larger; configurable via a variable). The image SHALL be Debian 13 (Trixie) — Debian 12 (Bookworm) ships Podman 4.3.1 which lacks Quadlet (introduced in 4.4); Trixie ships Podman 5.x with Quadlet. A `scaleway_instance_ip` SHALL be attached so the public IP survives stop/start cycles. The root volume SHALL be declared explicitly with `size_in_gb`, `volume_type` (local SSD, `l_ssd`), and `delete_on_termination` to avoid `(known after apply)` plan opacity.

The instance SHALL additionally attach two persistent Block Storage volumes (one per app env) via `additional_volume_ids`, each declared as a separate `scaleway_block_volume` resource (see *Per-env persistence on dedicated block volumes*). Because these are standalone resources, attaching them is an in-place `additional_volume_ids` update (a server stop/start), NOT a VPS replacement, and the root volume's `size_in_gb`/`volume_type` SHALL be left unchanged by this attachment. Editing the root volume's local-SSD `size_in_gb` (which forces instance recreation) is NOT part of attaching the data volumes.

#### Scenario: Single VPS exists after apply

- **WHEN** `tofu apply` completes successfully
- **THEN** exactly one Scaleway instance SHALL be running with the configured commercial type and image
- **AND** the instance's image SHALL be `debian_trixie` (or a label that ships Podman ≥ 4.4)
- **AND** the instance SHALL have exactly two Block Storage volumes attached via `additional_volume_ids` (the per-env data volumes)

#### Scenario: Attaching the data volumes does not replace the VPS

- **GIVEN** an existing provisioned VPS with the data volumes not yet attached
- **WHEN** the two `scaleway_block_volume` resources are added to `additional_volume_ids` and `tofu apply` runs
- **THEN** the plan SHALL NOT show `scaleway_instance_server.vps` being replaced
- **AND** the plan MAY show the server stopping/starting to perform the attach
- **AND** the root volume SHALL retain its existing `size_in_gb` and `volume_type`

### Requirement: Host configuration converges in place

The infrastructure project SHALL apply changes to host configuration (files, directories, installed packages, container-runtime users, service states, firewall rules, kernel parameters, swap) on the running VPS without provisioning a fresh VPS. Editing managed host configuration SHALL NOT cause `scaleway_instance_server.vps` to be replaced.

The convergence mechanism SHALL satisfy the following properties:

- **State-tracked declarations.** The set of currently-declared managed entries SHALL be derivable from the project's tofu state. Removing an auto-clean entry from the project source SHALL cause the corresponding host artifact (file removed, ufw rule deleted, swap deactivated, user removed, etc.) to be removed on the next apply.
- **Idempotent operations.** Each managed entry's create/update operation SHALL be safe to re-run without observable effect when the host is already converged to the declared state. Re-applying with no source change SHALL be a no-op against the host.
- **Restart hooks per entry.** Each entry MAY declare a follow-up command (`on_change`) that runs after the entry is created or updated. The command SHALL run before any downstream entry that depends on the changed entry.
- **Ordered convergence.** Entries SHALL converge in an order that respects category dependencies: container-runtime users exist before directories that are chowned to them; directories exist before files are written into them; packages are installed before files belonging to those packages are written; app units are restarted only after their env files exist.
- **Auto-clean removal.** Removing a managed entry's declaration SHALL cause the corresponding host artifact to be removed on the next apply. Each entry's `on_destroy` hook SHALL stop any associated service (if applicable) before removing the file/rule/etc. There is no PINNED opt-out — the contract is uniform: declaration removed → artifact removed.

The mechanism is NOT required to detect or self-heal hand-edits made on the host between applies. Apply rewrites declared content from template, so drift on managed paths self-heals on the next apply that touches that entry.

#### Scenario: Content edit applies in place

- **GIVEN** the VPS is provisioned and a managed file's content is edited in source
- **WHEN** `tofu apply` runs
- **THEN** the plan SHALL show only in-place changes — no `scaleway_instance_server.vps` replacement
- **AND** the file's content on the host SHALL match the new template after apply
- **AND** any declared `on_change` hook for that entry SHALL have fired
- **AND** `/srv/wfe/<env>` data SHALL be unchanged

#### Scenario: Re-applying with no source change is a no-op

- **GIVEN** a previous tofu apply succeeded and no source has changed since
- **WHEN** `tofu apply` runs again
- **THEN** the plan SHALL show no changes
- **AND** no managed entry's content SHALL be rewritten to the host
- **AND** no `on_change` hook SHALL fire

#### Scenario: Entry removed from source

- **GIVEN** a managed entry (e.g., a sshd drop-in, a sysctl, a ufw rule, a Quadlet, an env file) is removed from the project source
- **WHEN** `tofu apply` runs
- **THEN** the corresponding host artifact SHALL no longer exist
- **AND** any declared `on_destroy` hook (including service-stop steps for Quadlet/env-file entries) SHALL have fired

### Requirement: Managed user accounts

Per-tenant container-runtime user accounts SHALL be declared in the project's managed-users configuration and created, updated, and removed via the in-place convergence mechanism — NOT via cloud-init. Specifically: `wfe-prod`, `wfe-staging`, and `wfe-caddy` (one per Quadlet tenant) SHALL each be managed entries with:

- a `nologin` shell;
- a locked password (no interactive login);
- no SSH authorized keys (no `AllowUsers` entry);
- membership in no privileged groups;
- a non-overlapping subuid range of at least 65536 ids declared explicitly per user (auto-allocation across alphabetical ordering is forbidden — declared ranges SHALL be stable across applies so existing on-disk subuid-mapped ownership is not invalidated when entries are added or removed);
- `loginctl enable-linger` so the user's systemd-user.service starts at host boot and persists user-mode Quadlet units across operator logout cycles.

The `/etc/subuid` and `/etc/subgid` files SHALL be managed via the convergence mechanism's `managed_files` map (rendered from the managed-users declaration with deterministic ordering). The `usermod --add-subuids` mechanism SHALL NOT be used because `useradd`'s auto-allocation stacks beneath the explicit range, leaving each user with two ranges and breaking cross-tenant isolation.

Subuid range overlaps between two managed users SHALL fail at plan time (precondition check).

The `deploy` user is administrative-only and SHALL continue to be created by cloud-init (chicken-and-egg: tofu cannot SSH in until deploy exists). Deploy SHALL NOT be a managed-user entry.

Removing a `wfe-*` user from the configuration SHALL succeed only if all dependents (Quadlet, dirs, env file entries) are also removed in the same apply; otherwise `userdel` fails on running processes and apply errors out (fail-loud).

#### Scenario: Adding a new tenant is tofu-only

- **GIVEN** the operator adds a new tenant entry to managed-users (e.g., `wfe-experimental`) along with its dirs, env file, and Quadlet entries
- **WHEN** `tofu apply` runs
- **THEN** the plan SHALL NOT show `scaleway_instance_server.vps` being replaced
- **AND** the `wfe-experimental` user SHALL exist on the host with the declared shell, lock, and subuid range
- **AND** the corresponding Quadlet SHALL be running with `User=wfe-experimental`

#### Scenario: Removing a tenant cleans up host state

- **GIVEN** all entries for tenant `wfe-staging` (user, dirs, env file, Quadlet) are removed from source in the same apply
- **WHEN** `tofu apply` runs
- **THEN** the Quadlet's service SHALL stop first (dependents destroyed before user)
- **AND** the `wfe-staging` user SHALL be removed via `userdel --remove`
- **AND** the apply SHALL succeed

#### Scenario: Subuid range overlap fails at plan time

- **GIVEN** two managed-user entries declare overlapping subuid ranges
- **WHEN** `tofu plan` runs
- **THEN** the plan SHALL fail with an error identifying the overlap

#### Scenario: Half-removed tenant fails apply

- **GIVEN** a `managed_users` entry is removed but the tenant's Quadlet entry is NOT removed in the same apply
- **WHEN** `tofu apply` runs
- **THEN** `userdel` SHALL fail because the container process is running as that user
- **AND** the apply SHALL error out without modifying tenant state

### Requirement: Cloud-init bootstraps the box

The Scaleway server SHALL receive a cloud-init `user_data` payload limited to the first-boot operations required for tofu to SSH in and apply the in-place convergence mechanism. Specifically, cloud-init SHALL:

- Create the `deploy` user (operator/admin) with the operator's authorized SSH key from `var.deploy_ssh_public_key`. Lock its password. Place it in groups `adm` and `systemd-journal` so the operator can run `journalctl -u <unit>` without sudo.
- Write `/etc/sudoers.d/deploy` granting `deploy` NOPASSWD access to the converge primitives enumerated in `host-security-baseline` §"Privilege isolation: deploy administers; per-tenant wfe-* run unprivileged". This file is owned EXCLUSIVELY by cloud-init — the convergence mechanism does NOT manage it (see the archived change `host-config-converge-in-place` design.md D10 for the destroy/create race rationale). Editing the sudoers list automatically triggers VPS replacement via the `terraform_data.cloud_init_bootstrap` content hash + `replace_triggered_by` lifecycle rule.
- Configure sshd via a drop-in to listen on the configured non-default port, restrict `AllowUsers` to `deploy` only, disable root login, disable password and keyboard-interactive auth, set `MaxAuthTries 3`, set `LoginGraceTime 20s`, and require key-based auth. Restart sshd.
- Install the apt packages required by cloud-init itself (`ufw`, `sudo`).
- Set `DEFAULT_FORWARD_POLICY=ACCEPT` in `/etc/default/ufw` so that rootless container egress (DNS, image pulls, ACME) traverses the Podman bridge.
- Enable ufw with `default deny incoming`, `default allow outgoing`, `default allow routed`, and ONLY the configured SSH port allowed inbound. App-side rules (80, 443) are added by the convergence mechanism (see `managed_ufw`).

Cloud-init SHALL NOT include any operation outside the bootstrap minimum above. Specifically, cloud-init SHALL NOT install application packages (`podman`, `fail2ban`, `unattended-upgrades`, `curl`, `ca-certificates`), write hardening drop-ins beyond the bootstrap sshd config, write fail2ban jails, write sysctl drop-ins, write podman-auto-update timer overrides, allocate subuid ranges (those come from managed_files for /etc/subuid + /etc/subgid), create directories under `/srv` or `/etc/wfe` or `/etc/caddy`, provision the swapfile, enable `fail2ban.service` / `unattended-upgrades.service`, or create the `wfe-*` container-runtime users. All of those SHALL be applied via the convergence mechanism.

The Scaleway provider treats `user_data` as API-mutable; without an explicit replace trigger, edits to the cloud-init template would update the metadata field on the existing instance without re-executing cloud-init (which runs only at first boot). The project SHALL therefore declare `resource "terraform_data" "cloud_init_bootstrap"` with `input = sha256(<rendered cloud-init content>)`, and `scaleway_instance_server.vps` SHALL declare `lifecycle { replace_triggered_by = [terraform_data.cloud_init_bootstrap] }`. Edits to bootstrap-minimum content (deploy SSH key, sshd hardening, sudoers, ssh_port, FORWARD policy) flip the hash → tofu plans a `-/+ destroy and then create replacement`. VPS replacement SHALL otherwise be triggered ONLY by changes to the underlying Scaleway resource shape (instance type, image, root volume).

Per-env persistence lives on detachable Block Storage volumes (see *Per-env persistence on dedicated block volumes*), so `/srv/wfe/{prod,staging}` data SHALL survive a VPS replacement automatically — the volumes detach from the destroyed instance and reattach to its replacement. No rsync-and-restore ritual is required to preserve env data across a rebuild. Only `/srv/caddy` ACME state remains on the ephemeral root and is re-issued by Caddy after a rebuild.

The `null_resource.wait_cloud_init` resource SHALL invoke `cloud-init status --wait || [ $? -eq 2 ]` followed by `cloud-init status | grep -q '^status: done$'`. cloud-init exits 2 on recoverable errors (deprecation warnings, Scaleway-Debian-image-specific module noise); these are benign and SHALL NOT block apply. The textual status field is the load-bearing assertion.

#### Scenario: First boot reaches an SSH-ready state

- **WHEN** the VPS finishes its first boot
- **THEN** `cloud-init status` SHALL report `done`
- **AND** sshd SHALL accept key-only logins for `deploy` only on the configured port, with root disabled, password auth disabled
- **AND** ufw SHALL be enabled with `default deny incoming` and only the configured SSH port allowed
- **AND** `id deploy` SHALL show membership in `adm` and `systemd-journal`

#### Scenario: Edits beyond bootstrap minimum do not replace the VPS

- **GIVEN** any in-place-managed configuration is edited (sshd hardening drop-in, fail2ban jail, sysctl, packages list, dirs, swap, ufw rules for 80/443, Quadlets, env files, etc.)
- **WHEN** `tofu apply` runs
- **THEN** the plan SHALL NOT show `scaleway_instance_server.vps` being replaced

#### Scenario: Edits to bootstrap minimum still replace the VPS

- **GIVEN** the operator edits cloud-init's bootstrap minimum (e.g., changes the configured SSH port or rotates the deploy public key in cloud-init)
- **WHEN** `tofu apply` runs
- **THEN** the plan SHALL show `scaleway_instance_server.vps` being replaced
- **AND** `/srv/wfe/{prod,staging}` data SHALL be intact after the rebuild because it lives on Block Storage volumes that detach and reattach (no off-host rsync required)

### Requirement: Quadlet units for caddy, wfe-prod, wfe-staging

The project SHALL render three Quadlet `.container` files as **user-mode** systemd units under each tenant's `/home/<user>/.config/containers/systemd/` via the in-place convergence mechanism. Quadlets SHALL NOT be placed at the system-mode path `/etc/containers/systemd/`. The Quadlet's `User=` directive SHALL NOT be set (that directive sets the in-container UID, not the host process user — host-level rootless requires user-mode placement, not the `User=` directive).

Each tenant's user-mode systemd is started at host boot via `loginctl enable-linger <user>` (handled in the managed-user create step). Podman runs rootless under each tenant user, so a successful container escape lands on that unprivileged user — not on `root` and not on `deploy`.

Quadlet contents:

- `caddy.container` (under `/home/wfe-caddy/.config/containers/systemd/`) referencing the Caddy image, with `Network=host` (Caddy must reach `127.0.0.1:8081/8082` to proxy to the apps; under bridge networking, the container's own loopback would not see those upstreams). `PublishPort=` is therefore omitted (host networking binds 80/443/443/udp directly via the user namespace, permitted by the `net.ipv4.ip_unprivileged_port_start=80` sysctl). Volumes: `/srv/caddy/data:/data:Z`, `/srv/caddy/config:/config:Z`, `/etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro,Z`.
- `wfe-prod.container` (under `/home/wfe-prod/.config/containers/systemd/`) referencing `ghcr.io/<owner>/<repo>:release`, with `Label=io.containers.autoupdate=registry`, `PublishPort=127.0.0.1:8081:8080`, `Volume=/srv/wfe/prod:/data:Z,U` (the `:U` flag chowns the bind-mount source to the container's in-container UID 65532, mapped through the wfe-prod user's subuid range), `EnvironmentFile=/etc/wfe/prod.env` (secrets only), and `Environment=` directives for non-secret config (`PERSISTENCE_PATH`, `PORT`, `AUTH_PROVIDER`, `BASE_URL`, `AUTH_ALLOW`). Non-secrets are passed via `Environment=` rather than `EnvironmentFile=` because Podman's `--env-file` parser mis-splits comma-bearing values like `AUTH_ALLOW`.
- `wfe-staging.container` (under `/home/wfe-staging/.config/containers/systemd/`) referencing `ghcr.io/<owner>/<repo>:main`, identical shape pointing at `/srv/wfe/staging` and host port 8082.

Each file SHALL include `[Install] WantedBy=multi-user.target default.target`.

`/etc/wfe/` SHALL be mode `0711` (owner deploy, traversal allowed for others) so each tenant's user-mode systemd can `open()` its own `<env>.env` file via `EnvironmentFile=`. Per-file ownership (mode `0600`, owner `wfe-<env>:wfe-<env>`) prevents cross-tenant reads of the secret content.

The Quadlet entries are managed entries with stage `post` and on-change hook that runs `daemon-reload + restart` against the tenant's user-mode systemd via `sudo runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/$(id -u <user>) /bin/systemctl --user ...`. The Caddyfile entry has stage `pre` (Caddy must read the Caddyfile via bind mount before the container starts).

#### Scenario: All three units start after apply

- **GIVEN** `tofu apply` has completed against a fresh VPS
- **WHEN** the operator queries each tenant's user-mode systemd (e.g. `sudo runuser -u wfe-prod -- env XDG_RUNTIME_DIR=/run/user/$(id -u wfe-prod) /bin/systemctl --user is-active wfe-prod.service`, similarly for wfe-staging and wfe-caddy)
- **THEN** all three SHALL print `active`
- **AND** each unit's process SHALL run as the corresponding `wfe-<tenant>` host UID (verified via `ps -eo user,comm`); no workload process SHALL show `root` or `deploy`

#### Scenario: Quadlet content edit restarts only that unit in place

- **GIVEN** the rendered `wfe-prod.container` template content is changed (e.g., `MemoryMax` adjusted)
- **WHEN** `tofu apply` runs
- **THEN** the plan SHALL show no `scaleway_instance_server.vps` replacement
- **AND** the new file SHALL be installed at `/etc/containers/systemd/wfe-prod.container`
- **AND** `daemon-reload` SHALL fire
- **AND** `wfe-prod.service` SHALL restart with the new content
- **AND** `wfe-staging.service` and `caddy.service` SHALL be unaffected

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

- `workflow-engine.stho.net { tls <acme-email> ; reverse_proxy 127.0.0.1:8081 }`
- `staging.workflow-engine.stho.net { tls <acme-email> ; reverse_proxy 127.0.0.1:8082 }`

The hostnames SHALL be composed from a `base_domain` variable (default `stho.net`) as `workflow-engine.${base_domain}` and `staging.workflow-engine.${base_domain}`, so a future domain change is a single-variable edit. Note: staging's public hostname is served by Bunny Magic Containers, not the VPS; the staging site block remains rendered for the warm-fallback path but is not the live staging frontend.

Caddy's automatic HTTPS SHALL provide HTTP→HTTPS redirect, HSTS, and TLS termination via Let's Encrypt HTTP-01 ACME. ACME state SHALL persist on the host volume mounted at `/data` (i.e. `/srv/caddy/data` on the host).

#### Scenario: Prod hostname serves a publicly-trusted cert

- **GIVEN** the Bunny DNS A record for `workflow-engine.stho.net` has propagated to the VPS IP and Caddy has completed ACME
- **WHEN** an external client runs `curl -I https://workflow-engine.stho.net`
- **THEN** it SHALL return `200` (or whatever the app returns) with a valid Let's Encrypt-issued chain

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

Each app SHALL run with `PERSISTENCE_PATH=/data` (via Quadlet `Environment=`) and a host bind mount at `/srv/wfe/<env>:/data:Z,U`. The `:U` flag is required: it makes Podman recursively chown the bind-mount source to the container's UID 65532 (mapped through the tenant's subuid range) at start time, otherwise the container process can't write to a source initially owned by `deploy`/`root`. `PERSISTENCE_PATH` roots the tenant bundle tree (`workflows/`).

Each app SHALL also set `DATABASE_URL=file:/data/events.db` and `DATABASE_WAL=true` (via Quadlet `Environment=`), naming the embedded on-disk libSQL database that the `event-store` and `queues` stores use. The database location is now determined by `DATABASE_URL`, not derived from `PERSISTENCE_PATH`; the configured `file:` path SHALL remain under the bind-mounted persistent volume. The change SHALL NOT set `DATABASE_AUTH_TOKEN` on the VPS apps — prod and the VPS staging fallback remain embedded.

Each `/srv/wfe/<env>` path SHALL be the **mount point of that env's dedicated Block Storage volume** (see *Per-env persistence on dedicated block volumes*), not a plain subdirectory of the root filesystem. The two envs SHALL NOT share a persistence directory and SHALL NOT share a device. The Quadlet bind-mount line (`Volume=/srv/wfe/<env>:/data:Z,U`) is unchanged by this — the app/container layer is oblivious to whether the path is a directory or a mount point.

#### Scenario: Per-env data lives on separate mounted devices

- **GIVEN** the VPS has been provisioned and the data volumes attached
- **WHEN** the operator inspects `/srv/wfe/` and the mount table
- **THEN** `prod/` and `staging/` SHALL each be a mount point backed by a distinct Block Storage volume
- **AND** no two envs SHALL resolve to the same backing device
- **AND** after the env's container has started, the mounted filesystem's contents SHALL be owned by the tenant's mapped UID (in-container UID 65532, chowned by Podman's `:U` option)

#### Scenario: Database connection env names the embedded file under the volume

- **WHEN** the operator inspects a `wfe-<env>.container` Quadlet unit's `Environment=` directives
- **THEN** they SHALL include `DATABASE_URL=file:/data/events.db` and `DATABASE_WAL=true`
- **AND** they SHALL NOT include `DATABASE_AUTH_TOKEN`
- **AND** the `file:` path SHALL resolve under the `/data` bind mount (`/srv/wfe/<env>`)

### Requirement: Per-env secret env files

Per-env env files at `/etc/wfe/<env>.env` SHALL contain ONLY values whose presence in tofu state is an acceptable trade-off (the `encryption {}` block AES-GCM-encrypts state at rest with `var.state_passphrase`). Currently those values are: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SECRETS_PRIVATE_KEYS` (auto-generated; see "Auto-generated workflow-secrets sealing key" below).

The env file is a managed entry in the convergence mechanism with: stage `pre`; mode `0600`; owner `wfe-<env>:wfe-<env>` (so the tenant's user-mode systemd can read it via `EnvironmentFile=`); on-change hook `sudo runuser -u wfe-<env> -- env XDG_RUNTIME_DIR=/run/user/$(id -u wfe-<env>) /bin/systemctl --user restart wfe-<env>.service` (with a `|| true` swallow so the first-apply case where the unit doesn't yet exist is non-fatal). Auto-clean removal: removing the entry from source stops the tenant's service and removes the file. The parent directory `/etc/wfe/` is mode `0711` so cross-tenant traversal is allowed but listing is owner-only; per-file `0600` mode prevents cross-tenant reads of secret content.

Non-secret config (`AUTH_ALLOW`, `BASE_URL`, `AUTH_PROVIDER`, `PERSISTENCE_PATH`, `PORT`, `DATABASE_URL`, `DATABASE_WAL`) SHALL be passed via Quadlet `Environment=` directives, not via the env file. Justification: Podman's `--env-file` parser mis-splits comma-bearing values (notably `AUTH_ALLOW`); `--env KEY=VALUE` (one per `Environment=` directive) is parsed correctly. A future remote-backend cutover that introduces `DATABASE_AUTH_TOKEN` SHALL place it in the secret env file (it is auth material), not in a `Environment=` directive.

The implementation SHALL NOT use `local_file` or `local_sensitive_file` (those leak secrets through additional state attributes beyond the consuming managed entry's hash trigger).

#### Scenario: A secret rotation triggers a unit restart in place

- **GIVEN** `TF_VAR_gh_oauth_client_secret_prod` is updated in the operator's secret store
- **WHEN** `tofu apply` is re-run
- **THEN** the rendered env-file content differs from the previous apply
- **AND** the managed entry's content hash trigger flips → the file is rewritten to `/etc/wfe/prod.env`
- **AND** `wfe-prod.service` SHALL be restarted
- **AND** the plan SHALL NOT show `scaleway_instance_server.vps` being replaced

#### Scenario: Database connection env is non-secret on the VPS

- **WHEN** the operator inspects how `DATABASE_URL` and `DATABASE_WAL` reach a VPS app
- **THEN** they SHALL be passed via Quadlet `Environment=` directives, not via `/etc/wfe/<env>.env`

### Requirement: Auto-generated workflow-secrets sealing key

The project SHALL declare `random_bytes.secrets_key` per env (32 bytes each, base64-encoded). The env file SHALL render `SECRETS_PRIVATE_KEYS=v1:${random_bytes.secrets_key[<env>].base64}` so the runtime's workflow-secrets feature has its sealing key. The key is generated once on first apply and preserved across applies (state-tracked). Rotation: `tofu taint 'random_bytes.secrets_key["<env>"]'` then apply.

Multi-key staged rotation (concurrent decrypt against retired key + seal against new) is NOT supported by this scheme — it would require manual `keyId:base64,keyId:base64` composition. Single-key auto-generation is sufficient until uploaded bundles reference older keyIds.

#### Scenario: Key persists across applies

- **GIVEN** an apply has generated `random_bytes.secrets_key["prod"]`
- **WHEN** a subsequent apply runs without taint
- **THEN** the key value SHALL be unchanged
- **AND** the env file's `SECRETS_PRIVATE_KEYS` line SHALL be byte-identical

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

### Requirement: Daily disk cleanup service

The infrastructure project SHALL manage a root-owned systemd oneshot service `disk-cleanup.service` and a sibling `disk-cleanup.timer` on the VPS. The timer SHALL fire once per day with `Persistent=true` so a missed firing (host off, suspended, or upgrading) is caught on the next boot rather than skipped. The service SHALL execute a single script that performs the following reclaim steps in order, each idempotent and safe to no-op when nothing is reclaimable:

1. `apt-get clean` — removes downloaded package archives from `/var/cache/apt/archives/`. SHALL NOT remove installed packages or alter `dpkg` state.
2. `journalctl --vacuum-size=200M --vacuum-time=14d` — caps the persistent systemd journal at 200 MB AND drops entries older than 14 days. Both thresholds SHALL apply (whichever bites first).
3. For each rootless tenant managed by this project (currently `wfe-prod`, `wfe-staging`, `wfe-caddy`): `runuser -u <tenant> -- podman image prune -a -f`. The `-a` flag SHALL be used so the prune removes every image not referenced by a container, not just dangling (`<none>:<none>`) images — this reclaims both previous `:main` digests left behind by auto-update AND any tagged-but-unused side-images. Running containers' images SHALL NOT be pruned (podman enforces this via in-use references).

The unit's three files — `/etc/systemd/system/disk-cleanup.service`, `/etc/systemd/system/disk-cleanup.timer`, and `/usr/local/sbin/disk-cleanup.sh` — SHALL be declared as managed-file entries inside the existing `host.tf` convergence mechanism so they participate in the in-place apply semantics defined by *Host configuration converges in place*. The `on_change` hook for the timer file SHALL `systemctl daemon-reload` and `systemctl enable --now disk-cleanup.timer`. The `on_destroy` hooks SHALL `systemctl disable --now disk-cleanup.timer` before removing the files so declaration removal cleans the host.

The timer SHALL NOT run as the `deploy` user or any rootless tenant. It SHALL run as root because `apt-get clean` and `journalctl --vacuum-*` require root and because invoking `runuser` to reach each tenant's user systemd requires root.

#### Scenario: Timer is active after apply

- **GIVEN** the VPS is provisioned and the change is applied via `tofu apply`
- **WHEN** an operator runs `systemctl status disk-cleanup.timer` on the host
- **THEN** the timer SHALL report `Loaded: loaded` and `Active: active (waiting)`
- **AND** `systemctl list-timers disk-cleanup.timer` SHALL show the next firing within the next 24 hours

#### Scenario: First firing produces an observable run

- **GIVEN** the timer has been enabled and a fire window has elapsed
- **WHEN** the operator runs `journalctl -u disk-cleanup.service --since "-25h"`
- **THEN** the journal SHALL contain at least one invocation of `disk-cleanup.service`
- **AND** that invocation SHALL exit `Status=0/SUCCESS`

#### Scenario: Unused rootless images are reclaimed

- **GIVEN** `podman-auto-update.timer` has moved the `:main` tag forward on a tenant since the last cleanup, leaving the previous digest as an unreferenced image
- **WHEN** the next `disk-cleanup.service` firing completes
- **THEN** `runuser -u <tenant> -- podman images --filter dangling=true` SHALL return no images for that tenant
- **AND** the previous `:main` digest SHALL no longer be present in `runuser -u <tenant> -- podman images --all`
- **AND** `runuser -u <tenant> -- podman images <repo>:main` SHALL still show the current tagged image (it is in use by the running container and was not pruned)

#### Scenario: Images held by running containers are never pruned

- **GIVEN** each rootless tenant runs exactly one long-lived container under a Quadlet, holding a reference to its image
- **WHEN** `disk-cleanup.service` runs (with `podman image prune -a -f`)
- **THEN** the image currently referenced by each tenant's running container SHALL remain in that tenant's rootless image store
- **AND** the running container SHALL NOT be restarted, stopped, or otherwise disturbed by the prune

#### Scenario: Journal stays bounded

- **GIVEN** the persistent journal at `/var/log/journal` is larger than 200 MB OR contains entries older than 14 days
- **WHEN** `disk-cleanup.service` runs
- **THEN** after the run `du -sh /var/log/journal` SHALL report a size no greater than 200 MB (plus the size of the *current* active journal file, which `--vacuum-size` does not touch)
- **AND** `journalctl --list-boots` SHALL NOT include boots whose newest entry is older than 14 days

#### Scenario: apt cache is emptied without altering installed packages

- **GIVEN** `/var/cache/apt/archives/` contains downloaded `.deb` files
- **WHEN** `disk-cleanup.service` runs
- **THEN** `/var/cache/apt/archives/` SHALL contain no `.deb` files (only the `partial/` and `lock` artifacts that `apt-get clean` leaves in place)
- **AND** `dpkg -l` SHALL list exactly the same packages as before the run

#### Scenario: Persistent firing catches a missed window

- **GIVEN** the VPS was powered off across the scheduled `OnCalendar` fire time
- **WHEN** the VPS boots and the timer becomes active
- **THEN** the timer SHALL fire `disk-cleanup.service` once shortly after boot (due to `Persistent=true`)
- **AND** subsequent firings SHALL resume on the daily schedule

#### Scenario: Declaration removal cleans the host

- **GIVEN** the change has been applied and the three managed-file entries exist in tofu state
- **WHEN** the three entries are removed from `host.tf` and `tofu apply` runs
- **THEN** the apply SHALL stop and disable `disk-cleanup.timer`
- **AND** the apply SHALL remove `/etc/systemd/system/disk-cleanup.service`, `/etc/systemd/system/disk-cleanup.timer`, and `/usr/local/sbin/disk-cleanup.sh` from the host
- **AND** `systemctl status disk-cleanup.timer` SHALL report `Loaded: not-found`

#### Scenario: Script failure is contained

- **GIVEN** one of the reclaim steps fails on a single firing (e.g. `podman image prune` errors for one tenant)
- **WHEN** the service exits non-zero
- **THEN** the failure SHALL be recorded in `journalctl -u disk-cleanup.service`
- **AND** the timer SHALL remain enabled and SHALL fire again at the next scheduled time
- **AND** no other systemd unit SHALL be restarted, stopped, or marked failed as a side effect

### Requirement: Per-env persistence on dedicated block volumes

The project SHALL declare one `scaleway_block_volume` resource per app env (`prod`, `staging`), each of type `sbs_5k` (5 000 IOPS tier), minimum size 5 GB, attached to the VPS via `additional_volume_ids`. The prod volume SHALL declare `lifecycle { prevent_destroy = true }` so `tofu destroy` or accidental removal fails loud; the staging volume SHALL be a plain resource (no `prevent_destroy`) so it remains freely re-creatable for fresh-starts.

Each volume SHALL be activated on the host via a uniform pattern owned by the in-place convergence mechanism:

- **Format (in a `managed_exec`-style one-shot):** the device SHALL be formatted `ext4` with a filesystem label `wfe-<env>` ONLY when `blkid -p <device>` reports no existing filesystem/partition signature. An already-formatted device SHALL NOT be reformatted. This guard is the sole protection against destroying existing data; a single `blkid -p` probe is sufficient.
- **Device identification:** the format step SHALL resolve the target device deterministically (e.g. via `/dev/disk/by-id/*<volume-id>*`), NOT by size (the two volumes share a size) and NOT by kernel device-order naming.
- **Mount (via a systemd `.mount` unit declared as a managed file):** a `srv-wfe-<env>.mount` unit SHALL mount the volume at `/srv/wfe/<env>` by `LABEL=wfe-<env>` with the `nofail` option (a detached/missing volume SHALL NOT wedge boot). The unit is a managed file: its `on_change` hook SHALL `daemon-reload` and `enable --now` the unit; its `on_destroy` hook SHALL `disable --now` and remove the unit. Mount configuration SHALL NOT be expressed as an `/etc/fstab` append.
- **Ordering:** the volume SHALL be mounted before the env's app container starts, so the container never writes into the bare mount point on the root filesystem.
- **Ownership handoff:** after mounting, a freshly-formatted volume root (owned `root:root` by `mkfs`, including `lost+found`) SHALL be `chown -R`'d to the env's tenant user and `chmod 0700`, so the container's `:U` bind-mount flag (which recursively chowns the source into the tenant's subuid range, performed as the unprivileged tenant) can operate. This chown SHALL be guarded on root-ownership so a reattached, already-subuid-owned volume is left untouched.

Each app Quadlet SHALL declare `ExecStartPre=/usr/bin/mountpoint -q /srv/wfe/<env>` so that, if the volume is not mounted, the container fails to start (loud failure surfaced by `/readyz`) rather than silently writing to non-durable root storage.

#### Scenario: First apply formats and mounts an empty volume

- **GIVEN** a freshly attached, unformatted Block Storage volume for an env
- **WHEN** `tofu apply` converges the host
- **THEN** the device SHALL be formatted `ext4` with label `wfe-<env>`
- **AND** `srv-wfe-<env>.mount` SHALL be active, mounting it at `/srv/wfe/<env>`
- **AND** the mount root SHALL be `chown`'d to the tenant so the container's `:U` flag succeeds
- **AND** the env's app container SHALL start and write its persistence under that mount

#### Scenario: Freshly formatted volume root is handed to the tenant

- **GIVEN** a newly `mkfs`'d volume whose root and `lost+found` are owned `root:root`
- **WHEN** the mount is enabled and the ownership handoff runs
- **THEN** the mount root SHALL be `chown -R`'d to the env's tenant user and `chmod 0700`
- **AND** the container's `:U` recursive chown into the subuid range SHALL succeed (no `operation not permitted`)
- **AND** a subsequently reattached, already-subuid-owned volume SHALL NOT be re-chowned

#### Scenario: An already-formatted volume is never reformatted

- **GIVEN** a Block Storage volume that already contains an `ext4` filesystem with data
- **WHEN** `tofu apply` converges the host (e.g. after a VPS replacement reattached the volume)
- **THEN** `blkid -p` SHALL detect the existing signature
- **AND** `mkfs` SHALL NOT run
- **AND** the prior data SHALL remain intact after mount

#### Scenario: Container refuses to start when its volume is unmounted

- **GIVEN** the env's Block Storage volume failed to attach or mount (and `nofail` allowed boot to continue)
- **WHEN** the env's app container unit is started
- **THEN** the `ExecStartPre` `mountpoint -q /srv/wfe/<env>` check SHALL fail
- **AND** the container SHALL NOT start
- **AND** no persistence SHALL be written to the bare mount point on the root filesystem

#### Scenario: Prod volume is protected from destruction

- **GIVEN** the prod `scaleway_block_volume` declares `prevent_destroy = true`
- **WHEN** an operator runs `tofu destroy` or removes the resource from source and applies
- **THEN** tofu SHALL refuse with a `prevent_destroy` error rather than deleting the volume

#### Scenario: Declaration removal cleans the mount unit

- **GIVEN** a `srv-wfe-<env>.mount` managed-file entry exists in tofu state
- **WHEN** the entry is removed from source and `tofu apply` runs
- **THEN** the apply SHALL `disable --now` the unit and remove `srv-wfe-<env>.mount` from the host
- **AND** no `/etc/fstab` line for `/srv/wfe/<env>` SHALL remain (none was ever written)

### Requirement: Swap activated via a systemd .swap unit

The swapfile SHALL be created in a `managed_exec`-style one-shot (`fallocate` the file, `chmod 0600`, `mkswap`, each idempotent) and activated via a `swapfile.swap` systemd unit declared as a managed file — NOT via an `/etc/fstab` swap line. The unit's `on_change` hook SHALL `daemon-reload` and `enable --now swapfile.swap`; its `on_destroy` hook SHALL `disable --now swapfile.swap` and remove the unit and the swapfile. Removing the declaration SHALL leave no `/etc/fstab` residue (none is written).

#### Scenario: Swap is active after apply

- **GIVEN** the VPS is provisioned and the change is applied
- **WHEN** the operator runs `swapon --show` on the host
- **THEN** `/swapfile` SHALL appear as active swap
- **AND** `systemctl status swapfile.swap` SHALL report the unit `active`

#### Scenario: Swap declaration removal cleans the host without fstab residue

- **GIVEN** the swap managed entries exist in tofu state
- **WHEN** the entries are removed from source and `tofu apply` runs
- **THEN** the apply SHALL `disable --now swapfile.swap`, remove the unit, and remove `/swapfile`
- **AND** `/etc/fstab` SHALL contain no swap line for `/swapfile`

### Requirement: Bunny DNS records owned by tofu

The project SHALL manage exactly two DNS records under the `stho.net` zone via the `bunnynet` provider. The zone SHALL be referenced through a `data "bunnynet_dns_zone"` lookup (read-only); the project SHALL NOT own or create the `stho.net` zone, its apex, or any record other than the two below.

- `workflow-engine.stho.net` → **A record** to the Scaleway VPS public IP (`scaleway_instance_ip.vps.address`).
- `staging.workflow-engine.stho.net` → **CNAME** to the Bunny Magic Containers CDN endpoint host (`*.b-cdn.net`).

Both records SHALL set `ttl = 300`. `BASE_URL`, the Caddy prod site block, and the staging `bunnynet_pullzone_hostname` SHALL all use the same `base_domain`-composed hostnames. The project SHALL NOT reference the Dynu API, the `restapi` provider, or `var.dynu_api_key`.

Switching staging back to the VPS SHALL be a hand-edit of the staging record from a CNAME (Bunny CDN host) to an A record (VPS IP) followed by `tofu apply`; the project SHALL NOT introduce a `staging_backend` toggle variable.

#### Scenario: Prod A record resolves to the VPS

- **GIVEN** tofu apply has completed and Bunny DNS propagation has occurred
- **WHEN** `dig workflow-engine.stho.net` is run from an external resolver
- **THEN** it SHALL resolve to the Scaleway VPS public IP

#### Scenario: Staging hostname resolves to the Bunny CDN endpoint

- **GIVEN** tofu apply has completed and Bunny DNS propagation has occurred
- **WHEN** `dig staging.workflow-engine.stho.net` is run from an external resolver
- **THEN** it SHALL resolve (via CNAME) to the Bunny Magic Containers CDN endpoint host

#### Scenario: No Dynu / restapi provider remains

- **WHEN** the rendered `infrastructure/` project and its `.terraform.lock.hcl` are inspected
- **THEN** there SHALL be no `restapi` provider, no `provider "restapi"` block, no `Mastercard/restapi` lockfile entry, and no `var.dynu_api_key` reference

#### Scenario: tofu does not own the stho.net zone

- **WHEN** the DNS configuration is inspected
- **THEN** the `stho.net` zone SHALL be referenced via a `data "bunnynet_dns_zone"` source (not a `resource`)
- **AND** only the two `workflow-engine` subdomain records SHALL be managed; the apex and any sibling records SHALL NOT appear in the plan

