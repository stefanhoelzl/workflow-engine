## ADDED Requirements

### Requirement: EVENT_STORE_* config fields

The runtime SHALL accept six new environment variables under the `EVENT_STORE_*` namespace, all coerced to numbers via Zod with the defaults specified below. These tune the EventStore's checkpoint cadence, commit retry policy, and SIGTERM drain budget. All are optional; production environments override defaults via the deployment manifest.

- `EVENT_STORE_CHECKPOINT_INTERVAL_MS` — default `3_600_000` (1 h). Floor on background `CHECKPOINT` cadence; the operation runs at most this often by timer, plus on-demand when thresholds trip.
- `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS` — default `100_000`. Threshold trigger: when DuckLake's inlined-row count exceeds this, `CHECKPOINT` runs without waiting for the timer.
- `EVENT_STORE_CHECKPOINT_MAX_CATALOG_BYTES` — default `10_485_760` (10 MiB). Threshold trigger: when the catalog file size exceeds this, `CHECKPOINT` runs without waiting for the timer.
- `EVENT_STORE_COMMIT_MAX_RETRIES` — default `5`. Maximum number of retries on a transient DuckLake commit failure before the invocation is dropped.
- `EVENT_STORE_COMMIT_BACKOFF_MS` — default `500`. Base backoff between retry attempts; exponential, capped at a sensible upper bound.
- `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` — default `60_000` (60 s). Maximum time the SIGTERM drain spends committing in-flight invocations. MUST be less than the K8s `terminationGracePeriodSeconds`.

The config schema SHALL annotate each field with the same `// biome-ignore lint/style/useNamingConvention: env var name` comment used by the existing `PERSISTENCE_*` and `SANDBOX_LIMIT_*` families.

#### Scenario: Defaults apply when env vars are unset

- **GIVEN** the runtime starts with no `EVENT_STORE_*` env vars set
- **WHEN** the config is parsed
- **THEN** the parsed config SHALL contain `EVENT_STORE_CHECKPOINT_INTERVAL_MS = 3_600_000`
- **AND** `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS = 100_000`
- **AND** `EVENT_STORE_CHECKPOINT_MAX_CATALOG_BYTES = 10_485_760`
- **AND** `EVENT_STORE_COMMIT_MAX_RETRIES = 5`
- **AND** `EVENT_STORE_COMMIT_BACKOFF_MS = 500`
- **AND** `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS = 60_000`

#### Scenario: Env var overrides default

- **GIVEN** the runtime starts with `EVENT_STORE_CHECKPOINT_INTERVAL_MS=300000`
- **WHEN** the config is parsed
- **THEN** the parsed config SHALL contain `EVENT_STORE_CHECKPOINT_INTERVAL_MS = 300_000`

#### Scenario: Non-numeric env var fails parsing

- **GIVEN** the runtime starts with `EVENT_STORE_COMMIT_MAX_RETRIES=not-a-number`
- **WHEN** the config is parsed
- **THEN** parsing SHALL throw a Zod validation error
- **AND** the error SHALL identify the offending field
