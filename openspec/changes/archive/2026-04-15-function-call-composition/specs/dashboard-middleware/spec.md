## REMOVED Requirements

### Requirement: Dashboard middleware orchestrates timeline + list

**Reason**: Cut from v1 dashboard scope. With only the list view surviving, no orchestration middleware is needed; the dashboard list page is served directly by a single Hono route.

**Migration**: Remove dashboard middleware. Wire the list page route directly in the HTTP server bootstrap.
