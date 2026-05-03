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

The Scaleway provider treats `user_data` as API-mutable; without an explicit replace trigger, edits to the cloud-init template would update the metadata field on the existing instance without re-executing cloud-init (which runs only at first boot). The project SHALL therefore declare `resource "terraform_data" "cloud_init_bootstrap"` with `input = sha256(<rendered cloud-init content>)`, and `scaleway_instance_server.vps` SHALL declare `lifecycle { replace_triggered_by = [terraform_data.cloud_init_bootstrap] }`. Edits to bootstrap-minimum content (deploy SSH key, sshd hardening, sudoers, ssh_port, FORWARD policy) flip the hash → tofu plans a `-/+ destroy and then create replacement`. The operator runs the rsync-and-restore migration ritual documented in `docs/infrastructure.md` to preserve `/srv` data across the rebuild. VPS replacement SHALL otherwise be triggered ONLY by changes to the underlying Scaleway resource shape (instance type, image, root volume).

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

