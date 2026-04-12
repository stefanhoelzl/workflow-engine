## ADDED Requirements

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. This capability reads `X-Auth-Request-User`
and `X-Auth-Request-Email` forwarded headers from oauth2-proxy; the
threat model treats forwarded-header trust as contingent on network
controls documented in `/SECURITY.md §5`.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add reliance on additional forwarded headers,
alter the identity signal consumed by downstream UI code, or conflict
with the rules listed in `/SECURITY.md §4` MUST update `/SECURITY.md §4`
in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §4`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §4`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §4`
- **THEN** no update to `/SECURITY.md §4` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
