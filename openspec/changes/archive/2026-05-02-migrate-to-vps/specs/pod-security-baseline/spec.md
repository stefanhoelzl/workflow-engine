## ADDED Requirements

### Requirement: Capability removed

This capability SHALL NOT carry any K8s-shaped requirements. K8s PodSecurity Admission, default-deny NetworkPolicy, and shared `securityContext` outputs do not exist on the single-VPS shape. The equivalent posture (rootless Podman + per-Quadlet subuid mapping + host firewall + loopback-only app binds + scoped NOPASSWD sudo + sshd hardening + fail2ban + secret-file modes + sysctls + per-Quadlet `MemoryMax=` + 1 GiB swapfile + unattended security upgrades) is captured by the `host-security-baseline` capability and SHALL be the canonical reference for workload-isolation requirements.

#### Scenario: Replacement capability exists

- **WHEN** an operator looks up workload-isolation requirements
- **THEN** the canonical source SHALL be `openspec/specs/host-security-baseline/spec.md`
- **AND** no K8s admission-control or NetworkPolicy primitive SHALL be in use

## REMOVED Requirements

### Requirement: Baseline module creates workload namespaces

**Reason**: The `pod-security-baseline` capability is replaced wholesale by the new `host-security-baseline` capability. The K8s primitive (namespace + PSA label) does not exist on the new single-VPS shape. Workload isolation is provided by rootless Podman + per-Quadlet subuid + host firewall.

**Migration**: See `host-security-baseline` capability requirements "Rootless Podman with subuid mapping" and "Host firewall default-deny".

### Requirement: Baseline module creates default-deny NetworkPolicy per namespace

**Reason**: NetworkPolicy is a Kubernetes primitive with no analog on a non-K8s host. Default-deny posture is provided at the host firewall layer plus loopback-only workload binds.

**Migration**: See `host-security-baseline` capability requirements "Host firewall default-deny" and "Workload binds restricted to loopback".

### Requirement: Baseline module exports shared securityContext defaults

**Reason**: Kubernetes `securityContext` does not exist on the new shape. Equivalent isolation comes from rootless Podman (no privileged escalation, no host UID 0) and per-Quadlet `MemoryMax`/`CPUQuota`.

**Migration**: See `host-security-baseline` capability requirement "Per-Quadlet resource ceilings".

### Requirement: Baseline module exports shared NetworkPolicy constants

**Reason**: NetworkPolicy primitive is gone (see above).

**Migration**: See `host-security-baseline` capability requirement "Host firewall default-deny".

### Requirement: Warn-then-enforce rollout

**Reason**: The PSA two-phase rollout is a K8s admission-control concept with no analog on the new shape. The new posture is enforced at provision time by the firewall, sysctls, sshd config, and per-Quadlet limits — there is no "warn" mode.

**Migration**: No equivalent. New posture is single-phase.

### Requirement: All workloads set pod and container securityContext

**Reason**: Kubernetes-shaped requirement; no Kubernetes on the new shape.

**Migration**: Equivalent invariant ("workloads do not run as root") is captured by `host-security-baseline` requirement "Rootless Podman with subuid mapping".

### Requirement: Writable paths via emptyDir

**Reason**: `emptyDir` is a K8s volume kind that does not exist on the new shape. Quadlet units use host bind mounts (`/srv/wfe/<env>`) for data and `Volume=tmpfs:...` for ephemeral writable paths if needed.

**Migration**: Captured implicitly in the `infrastructure` capability's Quadlet/volume requirements.

### Requirement: cert-manager namespace PSA enforcement

**Reason**: cert-manager is removed from the deployment entirely (replaced by Caddy's built-in ACME). No cert-manager namespace exists.

**Migration**: None required; cert-manager is gone. Caddy ACME state lives in a host bind mount described by the `infrastructure` capability.

### Requirement: Security context

**Reason**: The K8s threat-model anchor pointing at PSA / NetworkPolicy is replaced by the host-security-baseline anchor in `SECURITY.md §5`.

**Migration**: `SECURITY.md §5` is rewritten in this change to reference `host-security-baseline` and the new posture.
