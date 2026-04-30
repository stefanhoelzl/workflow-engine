## MODIFIED Requirements

### Requirement: App Deployment

The module SHALL create a `kubernetes_deployment_v1` running the provided `image` with `spec.replicas = 1`. The container SHALL listen on port 8080.

The Deployment SHALL set `spec.strategy.type = "Recreate"` and SHALL set `spec.template.spec.terminationGracePeriodSeconds = 90`.

The `replicas = 1` invariant is load-bearing for **two** capabilities:

1. The `auth` capability: the session-cookie sealing password is generated in memory at app startup and is not shared across pods. Running more than one replica would cause deterministic cookie-decryption failures whenever a request lands on a pod other than the one that sealed the cookie.

2. The `event-store` capability: the DuckLake catalog (a single DuckDB file at `events.duckdb` in the persistence root) is round-tripped through the storage backend with an unconditional PUT. There is no `If-Match` fence (S2 and UpCloud Object Storage do not implement conditional writes). Two concurrent pods writing to the catalog SHALL silently corrupt it.

`spec.strategy.type = "Recreate"` is therefore correctness-load-bearing: it guarantees Pod-old is fully terminated before Pod-new is scheduled, so there is no temporal overlap that could produce two concurrent writers under normal K8s operation.

`terminationGracePeriodSeconds = 90` covers the SIGTERM drain budget (`EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` default 60 s) plus a margin for the catalog PUTs that flush in-flight invocations.

Raising `replicas` above 1, switching `strategy.type` away from `Recreate`, or attaching a Horizontal Pod Autoscaler / a PodDisruptionBudget that tolerates more than 1 replica SHALL be blocked by the corresponding `auth` and `event-store` invariants recorded in `/SECURITY.md` until the cookie-sealing password is migrated to a shared mechanism AND the DuckLake catalog is migrated to a multi-writer-capable backend (e.g. a Postgres catalog).

#### Scenario: App pod running with a single replica

- **WHEN** `tofu apply` completes
- **THEN** exactly one app pod SHALL be running with the specified image
- **AND** the Deployment's `spec.replicas` SHALL equal 1

#### Scenario: Recreate strategy is set

- **WHEN** `tofu apply` completes
- **THEN** the Deployment's `spec.strategy.type` SHALL equal `"Recreate"`

#### Scenario: Termination grace period is 90 seconds

- **WHEN** `tofu apply` completes
- **THEN** the Deployment's `spec.template.spec.terminationGracePeriodSeconds` SHALL equal 90

#### Scenario: Raising replicas beyond one is blocked by spec invariants

- **GIVEN** a change proposal that sets `spec.replicas > 1` on the app Deployment
- **WHEN** the proposal is reviewed
- **THEN** the proposal SHALL include a migration of the session-cookie sealing password out of in-memory state (recorded in the `auth` capability)
- **AND** the proposal SHALL include a migration of the DuckLake catalog to a multi-writer-capable backend (recorded in the `event-store` capability)
- **AND** SHALL be blocked until both migrations are accepted

#### Scenario: Switching strategy.type away from Recreate is blocked

- **GIVEN** a change proposal that sets `spec.strategy.type` to `"RollingUpdate"` (or any value other than `"Recreate"`) without explicit `maxSurge: 0` constraint
- **WHEN** the proposal is reviewed
- **THEN** the proposal SHALL be rejected unless it can demonstrate that no temporal overlap of pods is possible during rollout
