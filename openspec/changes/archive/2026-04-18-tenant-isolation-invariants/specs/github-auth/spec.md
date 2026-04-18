## MODIFIED Requirements

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. This capability owns the API trust chain:
Bearer-token validation against GitHub and the `GITHUB_USER` allowlist
check.

The implementation SHALL additionally conform to the tenant isolation
invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"`
(I-T2). The `/api/workflows/:tenant` route is the load-bearing enforcement
point for I-T2 on the API trust surface: the upload handler validates the
`<tenant>` path parameter against the identifier regex AND against
`isMember(user, tenant)` before granting access; both must pass, and both
failures return an identical `404 Not Found` to prevent tenant
enumeration by allow-listed Bearer callers.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, alter the API trust chain (for example by
changing the token-validation call, the caching behavior, or the
allowlist semantics), alter the tenant-membership check on
`/api/workflows/:tenant`, or conflict with the rules listed in
`/SECURITY.md §4` or the invariant statement in `/SECURITY.md §1`
MUST update the corresponding section(s) of `/SECURITY.md` in the same
change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §4`, or the tenant-isolation
  invariant in `/SECURITY.md §1`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §4` and/or `/SECURITY.md §1`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §4` or the tenant-isolation invariant in
  `/SECURITY.md §1`
- **THEN** no update to `/SECURITY.md` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
