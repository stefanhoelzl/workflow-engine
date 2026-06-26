## MODIFIED Requirements

### Requirement: EVENT_STORE_* config fields

The runtime SHALL accept three environment variables under the `EVENT_STORE_*` namespace, all coerced to numbers via Zod with the defaults specified below. These tune the EventStore's commit retry policy and SIGTERM drain budget. All are optional; production environments override defaults via the deployment manifest.

- `EVENT_STORE_COMMIT_MAX_RETRIES` — default `5`. Maximum number of retries on a transient commit failure before the invocation is dropped.
- `EVENT_STORE_COMMIT_BACKOFF_MS` — default `500`. Base backoff between retry attempts; exponential, capped at a sensible upper bound.
- `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS` — default `60_000` (60 s). Maximum time the SIGTERM drain spends committing in-flight invocations. MUST be less than the deployment's termination grace period.

There SHALL NOT be any `EVENT_STORE_CHECKPOINT_*` variables — libSQL has no application-visible checkpoint operation, so the former checkpoint-cadence tuning no longer exists.

The config schema SHALL annotate each field with the same `// biome-ignore lint/style/useNamingConvention: env var name` comment used by the existing `PERSISTENCE_*` and `SANDBOX_LIMIT_*` families.

#### Scenario: Defaults apply when env vars are unset

- **GIVEN** the runtime starts with no `EVENT_STORE_*` env vars set
- **WHEN** the config is parsed
- **THEN** the parsed config SHALL contain `EVENT_STORE_COMMIT_MAX_RETRIES = 5`
- **AND** `EVENT_STORE_COMMIT_BACKOFF_MS = 500`
- **AND** `EVENT_STORE_SIGTERM_FLUSH_TIMEOUT_MS = 60_000`

#### Scenario: Env var overrides default

- **GIVEN** the runtime starts with `EVENT_STORE_COMMIT_BACKOFF_MS=1000`
- **WHEN** the config is parsed
- **THEN** the parsed config SHALL contain `EVENT_STORE_COMMIT_BACKOFF_MS = 1_000`

#### Scenario: Non-numeric env var fails parsing

- **GIVEN** the runtime starts with `EVENT_STORE_COMMIT_MAX_RETRIES=not-a-number`
- **WHEN** the config is parsed
- **THEN** parsing SHALL throw a Zod validation error
- **AND** the error SHALL identify the offending field

## REMOVED Requirements

### Requirement: S3 persistence configuration

**Reason**: The S3 storage backend never existed in code (the runtime ships an FS backend only) and is not part of the libSQL store. The `PERSISTENCE_S3_*` env vars are dead config.

**Migration**: None. No deployment sets `PERSISTENCE_S3_*`. Persistence is configured via `PERSISTENCE_PATH`, which roots both the libSQL database file (`events.db`) and tenant bundles.

### Requirement: Backend selection is mutually exclusive

**Reason**: With the S3 backend removed there is only one persistence backend (local disk under `PERSISTENCE_PATH`); there is no second backend to be mutually exclusive with.

**Migration**: None. Set `PERSISTENCE_PATH` only.
