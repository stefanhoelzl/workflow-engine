## ADDED Requirements

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication` and `/SECURITY.md §5 Infrastructure
and Deployment`, which together enumerate the trust level, entry
points, threats, current mitigations, residual risks, and rules
governing this capability. The reverse proxy owns route-to-middleware
bindings, TLS termination, and the public ingress boundary; its
configuration determines which requests reach the application and
under what trust assumptions.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add new publicly exposed routes, change
route-to-middleware bindings, alter TLS behavior, or conflict with the
rules listed in `/SECURITY.md §4` or `/SECURITY.md §5` MUST update the
affected section(s) of `/SECURITY.md` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §4` or `/SECURITY.md §5`
- **THEN** the proposal SHALL include the corresponding updates to the
  affected section(s) of `/SECURITY.md`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §4` or `/SECURITY.md §5`
- **THEN** no `/SECURITY.md` update is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
