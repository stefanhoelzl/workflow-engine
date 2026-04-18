## MODIFIED Requirements

### Requirement: Public ingress security context

The HTTP trigger SHALL conform to the threat model documented at `/SECURITY.md S3 Webhook Ingress`. HTTP triggers are the project's PUBLIC ingress surface; the threat model treats all trigger input as attacker-controlled.

The HTTP trigger SHALL additionally conform to the tenant isolation invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2). The `/webhooks/:tenant/:workflow/:path` route parses the `<tenant>` and `<workflow>` path parameters, validates both against the tenant identifier regex, and looks up the trigger in the registry keyed by `(tenant, workflow)`. A public caller cannot route a webhook into another tenant's workflow because the registry lookup requires an exact `(tenant, workflow)` pair match. The resulting `InvocationEvent` carries a `tenant` field stamped from the workflow's registration — not from the URL — so a request that matches a valid `(tenant, workflow)` pair produces an event whose `tenant` is correct by construction.

Changes that introduce new threats, weaken or remove a documented mitigation, add new trigger types, extend the payload shape passed to the sandbox, change trigger-to-route mapping semantics, relax the `(tenant, workflow)` lookup scoping, or conflict with the rules in `/SECURITY.md S3` or the invariant statement in `/SECURITY.md §1` MUST update the corresponding section(s) of `/SECURITY.md` in the same change proposal.

#### Scenario: Change alters threat model

- **GIVEN** a change to this capability that affects an item enumerated in `/SECURITY.md S3` or the tenant-isolation invariant in `/SECURITY.md §1`
- **WHEN** the change is proposed
- **THEN** the proposal SHALL include corresponding updates to `/SECURITY.md S3` and/or `/SECURITY.md §1`
