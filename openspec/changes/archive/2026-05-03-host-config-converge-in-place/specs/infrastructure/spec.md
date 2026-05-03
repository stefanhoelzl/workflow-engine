## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Cloud-init bootstraps the box

The Scaleway server SHALL receive a cloud-init `user_data` payload limited to the first-boot operations required for tofu to SSH in and apply the in-place convergence mechanism. Specifically, cloud-init SHALL:

- Create the `deploy` user (operator/admin) with the operator's authorized SSH key from `var.deploy_ssh_public_key`. Lock its password. Place it in groups `adm` and `systemd-journal` so the operator can run `journalctl -u <unit>` without sudo.
- Write `/etc/sudoers.d/deploy` granting `deploy` NOPASSWD access to the converge primitives enumerated in `host-security-baseline` §"Privilege isolation: deploy administers; per-tenant wfe-* run unprivileged". This file is owned EXCLUSIVELY by cloud-init — the convergence mechanism does NOT manage it (see design.md D10 for the destroy/create race rationale). Editing the sudoers list requires `tofu taint scaleway_instance_server.vps` to re-bake the bootstrap minimum.
- Configure sshd via a drop-in to listen on the configured non-default port, restrict `AllowUsers` to `deploy` only, disable root login, disable password and keyboard-interactive auth, set `MaxAuthTries 3`, set `LoginGraceTime 20s`, and require key-based auth. Restart sshd.
- Install the apt packages required by cloud-init itself (`ufw`, `sudo`).
- Set `DEFAULT_FORWARD_POLICY=ACCEPT` in `/etc/default/ufw` so that rootless container egress (DNS, image pulls, ACME) traverses the Podman bridge.
- Enable ufw with `default deny incoming`, `default allow outgoing`, `default allow routed`, and ONLY the configured SSH port allowed inbound. App-side rules (80, 443) are added by the convergence mechanism (see `managed_ufw`).

Cloud-init SHALL NOT include any operation outside the bootstrap minimum above. Specifically, cloud-init SHALL NOT install application packages (`podman`, `fail2ban`, `unattended-upgrades`, `curl`, `ca-certificates`), write hardening drop-ins beyond the bootstrap sshd config, write fail2ban jails, write sysctl drop-ins, write podman-auto-update timer overrides, allocate subuid ranges (those come from managed_files for /etc/subuid + /etc/subgid), create directories under `/srv` or `/etc/wfe` or `/etc/caddy`, provision the swapfile, enable `fail2ban.service` / `unattended-upgrades.service`, or create the `wfe-*` container-runtime users. All of those SHALL be applied via the convergence mechanism.

The Scaleway provider treats `user_data` as API-mutable, so editing the cloud-init template content updates the metadata field on the existing instance without forcing replacement. Cloud-init only runs at first boot; to actually re-execute the bootstrap minimum on an existing VPS, the operator SHALL run `tofu taint scaleway_instance_server.vps` (with the rsync-and-restore migration ritual documented in `docs/infrastructure.md`). VPS replacement SHALL otherwise be triggered ONLY by changes to the underlying Scaleway resource shape (instance type, image, root volume).

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
- **AND** the operator MUST have rsynced `/srv/wfe/*` data off-host before applying (per the operator runbook)

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

### Requirement: Per-env secret env files

Per-env env files at `/etc/wfe/<env>.env` SHALL contain ONLY values whose presence in tofu state is an acceptable trade-off (the `encryption {}` block AES-GCM-encrypts state at rest with `var.state_passphrase`). Currently those values are: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SECRETS_PRIVATE_KEYS` (auto-generated; see "Auto-generated workflow-secrets sealing key" below).

The env file is a managed entry in the convergence mechanism with: stage `pre`; mode `0600`; owner `wfe-<env>:wfe-<env>` (so the tenant's user-mode systemd can read it via `EnvironmentFile=`); on-change hook `sudo runuser -u wfe-<env> -- env XDG_RUNTIME_DIR=/run/user/$(id -u wfe-<env>) /bin/systemctl --user restart wfe-<env>.service` (with a `|| true` swallow so the first-apply case where the unit doesn't yet exist is non-fatal). Auto-clean removal: removing the entry from source stops the tenant's service and removes the file. The parent directory `/etc/wfe/` is mode `0711` so cross-tenant traversal is allowed but listing is owner-only; per-file `0600` mode prevents cross-tenant reads of secret content.

Non-secret config (`AUTH_ALLOW`, `BASE_URL`, `AUTH_PROVIDER`, `PERSISTENCE_PATH`, `PORT`) SHALL be passed via Quadlet `Environment=` directives, not via the env file. Justification: Podman's `--env-file` parser mis-splits comma-bearing values (notably `AUTH_ALLOW`); `--env KEY=VALUE` (one per `Environment=` directive) is parsed correctly.

The implementation SHALL NOT use `local_file` or `local_sensitive_file` (those leak secrets through additional state attributes beyond the consuming managed entry's hash trigger).

#### Scenario: A secret rotation triggers a unit restart in place

- **GIVEN** `TF_VAR_gh_oauth_client_secret_prod` is updated in the operator's secret store
- **WHEN** `tofu apply` is re-run
- **THEN** the rendered env-file content differs from the previous apply
- **AND** the managed entry's content hash trigger flips → the file is rewritten to `/etc/wfe/prod.env`
- **AND** `wfe-prod.service` SHALL be restarted
- **AND** the plan SHALL NOT show `scaleway_instance_server.vps` being replaced

## REMOVED Requirements

### Requirement: Cloud-init changes force VPS replacement

**Reason**: This requirement codified the very behavior this change is removing. Host-config edits no longer require VPS replacement; the in-place convergence mechanism applies them on the running VPS. VPS replacement is now triggered only by changes to the cloud-init bootstrap minimum or to the Scaleway resource shape.

**Migration**: Remove `terraform_data.cloud_init` and the `lifecycle { replace_triggered_by = [terraform_data.cloud_init] }` block from `infrastructure/main.tf`. Operators relying on "edit cloud-init → fresh VPS" for incidental host resets must use `tofu taint scaleway_instance_server.vps` instead. The new requirement "Cloud-init bootstraps the box" (modified above) defines the residual replacement-triggering surface.
