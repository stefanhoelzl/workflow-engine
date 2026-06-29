# host-security-baseline Specification

## Purpose
TBD - created by archiving change migrate-to-vps. Update Purpose after archive.
## Requirements
### Requirement: Capability removed

The `host-security-baseline` capability SHALL NOT carry any requirements. The Scaleway VPS it described is retired in this change, and prod now runs on bunny.net Magic Containers, where bunny.net owns host posture (sshd, firewall, OS patching, user accounts) and there is no operator-managed host to harden. The one requirement in this capability that was NOT VPS host posture — the worker→main host-call trust boundary, an app/sandbox security boundary per `SECURITY.md §2` — SHALL be preserved by moving it to the `sandbox-plugin` capability.

#### Scenario: No operator-managed host remains

- **WHEN** an operator looks up host-hardening requirements
- **THEN** there SHALL be no VPS host posture to own (bunny.net manages the host)
- **AND** the sandbox host-call trust boundary SHALL live in `openspec/specs/sandbox-plugin/spec.md`

