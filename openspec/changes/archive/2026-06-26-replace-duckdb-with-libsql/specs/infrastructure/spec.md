## MODIFIED Requirements

### Requirement: Local-disk persistence per env

Each app SHALL run with `PERSISTENCE_PATH=/data` (via Quadlet `Environment=`) and a host bind mount at `/srv/wfe/<env>:/data:Z,U`. The `:U` flag is required: it makes Podman recursively chown the bind-mount source to the container's UID 65532 (mapped through the tenant's subuid range) at start time, otherwise the container process can't write to a source initially owned by `deploy`/`root`. `PERSISTENCE_PATH` roots both the libSQL database file (`events.db`) and the tenant bundle tree (`workflows/`).

Each `/srv/wfe/<env>` path SHALL be the **mount point of that env's dedicated Block Storage volume** (see *Per-env persistence on dedicated block volumes*), not a plain subdirectory of the root filesystem. The two envs SHALL NOT share a persistence directory and SHALL NOT share a device. The Quadlet bind-mount line (`Volume=/srv/wfe/<env>:/data:Z,U`) is unchanged by this — the app/container layer is oblivious to whether the path is a directory or a mount point.

#### Scenario: Per-env data lives on separate mounted devices

- **GIVEN** the VPS has been provisioned and the data volumes attached
- **WHEN** the operator inspects `/srv/wfe/` and the mount table
- **THEN** `prod/` and `staging/` SHALL each be a mount point backed by a distinct Block Storage volume
- **AND** no two envs SHALL resolve to the same backing device
- **AND** after the env's container has started, the mounted filesystem's contents SHALL be owned by the tenant's mapped UID (in-container UID 65532, chowned by Podman's `:U` option)
