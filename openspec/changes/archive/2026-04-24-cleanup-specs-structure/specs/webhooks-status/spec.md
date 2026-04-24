## REMOVED Requirements

Both requirements are absorbed into `http-trigger` (the `GET /webhooks/` readiness endpoint is HTTP-trigger-specific behaviour, not a separate capability).

### Requirement: Webhooks subsystem readiness endpoint

**Reason**: Belongs in `http-trigger` alongside the other `/webhooks/*` routing requirements.

**Migration**: See `http-trigger` — same behaviour (204 when ≥1 HTTP trigger registered; 503 when none; no body; POST routes unaffected).

### Requirement: GET /webhooks/ returns liveness status

**Reason**: Same absorption. Note: the two requirements overlap (both describe the 204/503 behaviour); the absorption into `http-trigger` collapses them into a single requirement with the union of their scenarios.

**Migration**: See `http-trigger` — consolidated readiness requirement.
