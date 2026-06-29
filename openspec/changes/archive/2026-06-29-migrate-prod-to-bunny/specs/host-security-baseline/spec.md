## ADDED Requirements

### Requirement: Capability removed

The `host-security-baseline` capability SHALL NOT carry any requirements. The Scaleway VPS it described is retired in this change, and prod now runs on bunny.net Magic Containers, where bunny.net owns host posture (sshd, firewall, OS patching, user accounts) and there is no operator-managed host to harden. The one requirement in this capability that was NOT VPS host posture — the worker→main host-call trust boundary, an app/sandbox security boundary per `SECURITY.md §2` — SHALL be preserved by moving it to the `sandbox-plugin` capability.

#### Scenario: No operator-managed host remains

- **WHEN** an operator looks up host-hardening requirements
- **THEN** there SHALL be no VPS host posture to own (bunny.net manages the host)
- **AND** the sandbox host-call trust boundary SHALL live in `openspec/specs/sandbox-plugin/spec.md`

## REMOVED Requirements

### Requirement: Privilege isolation: deploy administers; per-tenant wfe-* run unprivileged

**Reason**: The Scaleway VPS is retired in this change. The deploy/`wfe-*` user split and its sudoers/SSH trust boundaries are VPS host posture with no analog on bunny.net Magic Containers, where bunny.net owns host access and user accounts and there is no operator-managed host shell.

**Migration**: None / not applicable — the VPS is gone. bunny.net runs the container; there are no host user accounts to manage.

### Requirement: Rootless Podman with subuid mapping

**Reason**: The Scaleway VPS is retired in this change. There are no Quadlets or host containers on bunny.net Magic Containers — bunny.net runs the container — so rootless Podman and per-tenant subuid mapping have no analog.

**Migration**: None / not applicable — the VPS is gone. Container execution is owned by the platform; see the `bunny-deployment` capability for the deployment shape.

### Requirement: Host firewall default-deny

**Reason**: The Scaleway VPS is retired in this change. bunny.net owns network and host access on Magic Containers; there is no operator-managed host firewall to configure.

**Migration**: None / not applicable — the VPS is gone. Network exposure is owned by the bunny.net platform.

### Requirement: Workload binds restricted to loopback

**Reason**: The Scaleway VPS is retired in this change. Loopback-only Quadlet publish rules are VPS host posture with no analog on bunny.net Magic Containers, where the platform owns how the container is exposed.

**Migration**: None / not applicable — the VPS is gone. See the `bunny-deployment` capability for how the container is reached.

### Requirement: Unprivileged port floor lowered for Caddy

**Reason**: The Scaleway VPS is retired in this change. The `net.ipv4.ip_unprivileged_port_start` sysctl is a host-kernel tunable with no operator-managed host to apply it to on bunny.net Magic Containers.

**Migration**: None / not applicable — the VPS is gone. bunny.net owns the host kernel and port exposure.

### Requirement: Per-Quadlet resource ceilings

**Reason**: The Scaleway VPS is retired in this change. There are no Quadlets or host containers on bunny.net Magic Containers — bunny.net runs the container — so per-Quadlet memory caps have no analog.

**Migration**: Per-container memory is sized by the platform; see the `bunny-deployment` capability.

### Requirement: Swapfile

**Reason**: The Scaleway VPS is retired in this change. There is no operator-managed host to configure a swapfile on; bunny.net owns the host's memory and swap posture on Magic Containers.

**Migration**: None / not applicable — the VPS is gone.

### Requirement: SSH hardening

**Reason**: The Scaleway VPS is retired in this change. sshd configuration is VPS host posture with no analog on bunny.net Magic Containers, where bunny.net owns network and host access and there is no operator SSH path.

**Migration**: None / not applicable — the VPS is gone. There is no host to SSH into.

### Requirement: fail2ban with sshd jail

**Reason**: The Scaleway VPS is retired in this change. fail2ban guards an sshd that no longer exists; bunny.net owns network and host access on Magic Containers.

**Migration**: None / not applicable — the VPS is gone.

### Requirement: Secret env file modes

**Reason**: The Scaleway VPS is retired in this change. There are no host secret files on bunny.net Magic Containers — env is delivered as platform environment variables by bunny.net — so file modes and ownership on `/etc/wfe/<env>.env` have no analog.

**Migration**: Secret env is delivered as platform env vars; see the `bunny-deployment` capability.

### Requirement: Caddyfile and env-file directory layout

**Reason**: The Scaleway VPS is retired in this change. The `/etc/caddy/`, `/etc/wfe/`, and `/srv/wfe/` host directory layout is VPS host posture with no analog on bunny.net Magic Containers, where env is delivered as platform env vars and there are no host files.

**Migration**: Env and configuration are delivered by the platform; see the `bunny-deployment` capability.

### Requirement: Operator log access via group membership

**Reason**: The Scaleway VPS is retired in this change. `adm`/`systemd-journal` group membership for `journalctl` access is VPS host posture with no analog on bunny.net Magic Containers, where logs are read via the bunny.net dashboard/API.

**Migration**: Logs are accessed via the bunny.net dashboard/API; see the `bunny-deployment` capability.

### Requirement: Unattended security upgrades

**Reason**: The Scaleway VPS is retired in this change. OS security patching is owned by bunny.net on Magic Containers; there is no operator-managed host to run unattended-upgrades on.

**Migration**: None / not applicable — the VPS is gone. OS patching is owned by the bunny.net platform.

### Requirement: Worker→main host-call trust boundary

**Reason**: This is an app/sandbox security boundary (the plugin worker→main host-call channel, `SECURITY.md §2`), not VPS host posture, so it outlives the retired VPS.

**Migration**: Moved verbatim to the `sandbox-plugin` capability (`openspec/specs/sandbox-plugin/spec.md`).
