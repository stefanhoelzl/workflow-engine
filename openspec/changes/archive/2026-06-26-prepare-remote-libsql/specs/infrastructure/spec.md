## MODIFIED Requirements

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
