## ADDED Requirements

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §3 Webhook Ingress`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. Triggers — HTTP webhooks in particular —
are the project's PUBLIC ingress surface; the threat model treats all
trigger input as attacker-controlled.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add new trigger types, extend the payload
shape passed to the sandbox, change trigger-to-route mapping
semantics, or conflict with the rules listed in `/SECURITY.md §3`
MUST update `/SECURITY.md §3` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §3`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §3`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §3`
- **THEN** no update to `/SECURITY.md §3` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
