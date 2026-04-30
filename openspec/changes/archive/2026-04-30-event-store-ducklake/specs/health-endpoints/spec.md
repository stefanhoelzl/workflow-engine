## REMOVED Requirements

### Requirement: Persistence write deep check

**Reason**: The `persistence:write` deep check exercised `StorageBackend.write` with a string sentinel. The string-variant `write` method is removed from `StorageBackend` (only the byte-variant remains, used for tarballs and the DuckLake catalog). The health-relevant question for the new architecture is "can the runtime commit to DuckLake?", which is answered by the existing `eventstore` deep check via `eventStore.ping()`.

**Migration**: Drop the `persistence:write` check from the health middleware's check map. Operators relying on this check switch to the existing `eventstore` deep check (`/healthz?eventstore=true`) which exercises the DuckLake-attached connection. `/readyz` already runs all checks, so a sentinel sufficient for readiness gating is preserved.

### Requirement: Persistence read deep check

**Reason**: Symmetric with the write check — the string-variant `read` method is removed from `StorageBackend`, and the eventstore ping covers the relevant readiness signal.

**Migration**: Drop the `persistence:read` check from the health middleware's check map.

### Requirement: Persistence list deep check

**Reason**: The `persistence:list` check listed `pending/`, which no longer exists in the new layout. Listing the new `events/` partition tree is not a useful health signal (it could match many files for high-traffic deployments and would add latency to `/readyz`). The eventstore ping is the right readiness signal.

**Migration**: Drop the `persistence:list` check from the health middleware's check map.
