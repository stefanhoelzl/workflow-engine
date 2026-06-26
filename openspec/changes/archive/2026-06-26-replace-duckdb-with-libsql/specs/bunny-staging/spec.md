## MODIFIED Requirements

### Requirement: Staging persistent volume mounted at /data

The staging app SHALL declare one `bunnynet` volume mounted at `/data` so the libSQL EventStore database (`events.db`) and uploaded tenant bundles have a persistence path. Durability is **accept-loss**: Bunny volumes have no backups or replication and reattachment across reschedule is not guaranteed. This change SHALL NOT add backup, replication, sentinel, or forced-reschedule instrumentation; the risk SHALL be documented, not mitigated.

#### Scenario: Volume mounted at the persistence path

- **WHEN** the rendered `bunnynet_compute_container_app` is inspected
- **THEN** it SHALL declare exactly one volume mounted at `/data`
- **AND** the container env SHALL set `PERSISTENCE_PATH=/data`

#### Scenario: No durability instrumentation is added

- **WHEN** the change's infrastructure and CI files are inspected
- **THEN** no backup job, replication config, or volume-sentinel/forced-reschedule test SHALL be present
- **AND** the accept-loss posture SHALL be documented in `docs/` or the change design
