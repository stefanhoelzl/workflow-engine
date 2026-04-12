## ADDED Requirements

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. This capability owns the route-to-middleware
bindings that determine which UI routes require forward-auth; the
threat model treats the UI prefix family (`/dashboard`, `/trigger`,
and future authenticated UIs) as a single trust domain.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add new authenticated UI route prefixes, remove
forward-auth coverage from an existing UI route, or conflict with the
rules listed in `/SECURITY.md §4` MUST update `/SECURITY.md §4` in the
same change proposal.

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
