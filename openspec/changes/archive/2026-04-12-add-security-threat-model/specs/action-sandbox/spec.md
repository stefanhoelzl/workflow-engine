## ADDED Requirements

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §2 Sandbox Boundary`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, alter the sandbox trust boundary (for example
by adding a global, extending the host bridge, or changing context
disposal semantics), or conflict with the rules listed in
`/SECURITY.md §2` MUST update `/SECURITY.md §2` in the same change
proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §2`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §2`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §2`
- **THEN** no update to `/SECURITY.md §2` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
