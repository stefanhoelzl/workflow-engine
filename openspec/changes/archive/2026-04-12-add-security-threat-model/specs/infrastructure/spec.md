## ADDED Requirements

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §5 Infrastructure and Deployment`, which enumerates the
trust level, entry points, threats, current mitigations, residual
risks, rules, and production deployment requirements governing this
capability. Infrastructure changes determine the posture of the
running system: network exposure, secret handling, pod security, and
resource isolation.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add new exposed ports or services, alter
secret handling, modify pod security context or resource policy, or
conflict with the rules listed in `/SECURITY.md §5` MUST update
`/SECURITY.md §5` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk,
  rule, or production deployment requirement enumerated in
  `/SECURITY.md §5`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §5`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §5`
- **THEN** no update to `/SECURITY.md §5` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
