## REMOVED Requirements

### Requirement: Correlation-grouped event timeline view

**Reason**: Cut from v1 dashboard scope. Correlation IDs and event timelines were tied to the event-graph model that is removed; v1 has only invocations (no parent/child events), so a timeline visualization is not applicable.

**Migration**: Use the dashboard list view (see `dashboard-list-view` capability) for invocation-level visibility. A future timeline view could be reintroduced when subscribers/events return as opt-in primitives.
