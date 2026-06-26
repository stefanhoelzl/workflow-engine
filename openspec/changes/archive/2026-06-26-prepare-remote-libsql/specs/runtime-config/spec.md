## ADDED Requirements

### Requirement: Database connection config fields

The runtime SHALL parse three environment variables that define the libSQL connection for the `event-store` and `queues` stores, replacing the previous `PERSISTENCE_PATH`-derived database path:

- `DATABASE_URL` (**required**, `z.string()`): the libSQL connection URL. It MAY be a `file:…` URL (embedded on-disk database) or a `libsql://…`/`https://…` URL (remote libSQL service). There SHALL be no derivation from `PERSISTENCE_PATH`; an absent `DATABASE_URL` SHALL fail config parsing.
- `DATABASE_WAL` (string→boolean, default `false`): gates the embedded-only `PRAGMA journal_mode=WAL`. It SHALL be parsed by a real string→boolean parser (`z.stringbool`), NOT `z.coerce.boolean()` (which treats the string `"false"` as truthy). It is meaningful only for the embedded variant.
- `DATABASE_AUTH_TOKEN` (optional, `Secret`-wrapped): the auth token for a remote libSQL service. It SHALL be composed through `.transform(createSecret)` so it is redacted on serialization/logging like other secret-sourced fields. Its presence selects the remote client variant.

The schema SHALL apply a single cross-field refinement that fails closed at config parse time when `DATABASE_AUTH_TOKEN` is set **and** `DATABASE_WAL` is `true` (a contradictory remote-plus-embedded-pragma intent). No other scheme↔variant cross-validation SHALL be performed: a `libsql://` URL without a token, or a token alongside a `file:` URL, SHALL surface at connect/runtime, not at config parse.

`PERSISTENCE_PATH` SHALL remain a required field; it continues to root the tenant bundle tree (`workflows/`) via `createFsStorage`, but SHALL NOT determine the database location.

#### Scenario: Embedded config with WAL

- **WHEN** `createConfig` is called with `{ DATABASE_URL: "file:/data/events.db", DATABASE_WAL: "true", PERSISTENCE_PATH: "/data", SECRETS_PRIVATE_KEYS: "v1:..." }`
- **THEN** it SHALL return a config exposing `databaseUrl: "file:/data/events.db"`, `databaseWal: true`, and `databaseAuthToken: undefined`

#### Scenario: Missing DATABASE_URL fails closed

- **WHEN** `createConfig` is called without `DATABASE_URL`
- **THEN** it SHALL throw a validation error

#### Scenario: DATABASE_WAL string parsing is not coerce-boolean

- **WHEN** `createConfig` is called with `{ DATABASE_WAL: "false", DATABASE_URL: "file:/data/events.db", ... }`
- **THEN** the parsed `databaseWal` SHALL be `false` (the literal string `"false"` SHALL NOT parse as `true`)

#### Scenario: Auth token is Secret-wrapped and redacted

- **WHEN** `createConfig` is called with `{ DATABASE_AUTH_TOKEN: "tok_abc", DATABASE_URL: "libsql://db.example", ... }`
- **THEN** `databaseAuthToken` SHALL be a `Secret`
- **AND** `JSON.stringify(config.databaseAuthToken)` SHALL yield `"\"[redacted]\""`
- **AND** `config.databaseAuthToken.reveal()` SHALL yield `"tok_abc"`

#### Scenario: Contradictory remote+WAL combination fails closed

- **WHEN** `createConfig` is called with `{ DATABASE_AUTH_TOKEN: "tok_abc", DATABASE_WAL: "true", DATABASE_URL: "libsql://db.example", ... }`
- **THEN** it SHALL throw a validation error

#### Scenario: Remote URL without a token does not fail at config parse

- **WHEN** `createConfig` is called with `{ DATABASE_URL: "libsql://db.example", PERSISTENCE_PATH: "/data", SECRETS_PRIVATE_KEYS: "v1:..." }` and no `DATABASE_AUTH_TOKEN`
- **THEN** config parsing SHALL succeed (the missing token surfaces later, at connect time, not at parse)
