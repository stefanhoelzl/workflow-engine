# Pod Security Baseline Specification

## Purpose

Own the `modules/baseline/` OpenTofu module that enforces Kubernetes Pod Security Admission `restricted` profile on all workload namespaces, plus the shared security-context defaults applied to every workload (non-root user, read-only root filesystem, dropped capabilities, seccomp profile). Cross-references SECURITY.md §5.
## Requirements
### Requirement: Capability removed

This capability SHALL NOT carry any K8s-shaped requirements. K8s PodSecurity Admission, default-deny NetworkPolicy, and shared `securityContext` outputs do not exist on the single-VPS shape. The equivalent posture (rootless Podman + per-Quadlet subuid mapping + host firewall + loopback-only app binds + scoped NOPASSWD sudo + sshd hardening + fail2ban + secret-file modes + sysctls + per-Quadlet `MemoryMax=` + 1 GiB swapfile + unattended security upgrades) is captured by the `host-security-baseline` capability and SHALL be the canonical reference for workload-isolation requirements.

#### Scenario: Replacement capability exists

- **WHEN** an operator looks up workload-isolation requirements
- **THEN** the canonical source SHALL be `openspec/specs/host-security-baseline/spec.md`
- **AND** no K8s admission-control or NetworkPolicy primitive SHALL be in use

