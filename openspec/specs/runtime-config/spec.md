## Purpose

Runtime configuration parsing from environment variables into a typed config object.
## Requirements
### Requirement: Config parsing from environment
The runtime SHALL provide a `createConfig` function that accepts an environment record (`Record<string, string | undefined>`) and returns a typed, validated configuration object.

#### Scenario: Valid environment with all values provided
- **WHEN** `createConfig` is called with `{ LOG_LEVEL: "debug", PORT: "3000" }`
- **THEN** it SHALL return `{ logLevel: "debug", port: 3000 }`

#### Scenario: Empty environment uses defaults
- **WHEN** `createConfig` is called with `{}`
- **THEN** it SHALL return `{ logLevel: "info", port: 8080 }`

#### Scenario: Partial environment fills missing values with defaults
- **WHEN** `createConfig` is called with `{ PORT: "9090" }`
- **THEN** it SHALL return `{ logLevel: "info", port: 9090 }`

### Requirement: LOG_LEVEL validation
The `LOG_LEVEL` config value SHALL only accept valid pino log levels: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. It SHALL default to `info` when not provided.

#### Scenario: Valid log level
- **WHEN** `createConfig` is called with `{ LOG_LEVEL: "debug" }`
- **THEN** it SHALL return a config with `logLevel` set to `"debug"`

#### Scenario: Invalid log level
- **WHEN** `createConfig` is called with `{ LOG_LEVEL: "verbose" }`
- **THEN** it SHALL throw a validation error

### Requirement: PORT validation
The `PORT` config value SHALL be coerced from a string to a number. It SHALL default to `8080` when not provided.

#### Scenario: Valid port string
- **WHEN** `createConfig` is called with `{ PORT: "3000" }`
- **THEN** it SHALL return a config with `port` set to `3000` (number)

#### Scenario: Non-numeric port
- **WHEN** `createConfig` is called with `{ PORT: "abc" }`
- **THEN** it SHALL throw a validation error

### Requirement: Main entry point uses config object
The runtime entry point (`main.ts`) SHALL use the config object returned by `createConfig` for all server-level configuration instead of accessing `process.env` directly.

#### Scenario: Server startup uses config
- **WHEN** the runtime starts
- **THEN** the logger level SHALL be set from `config.logLevel`
- **AND** the HTTP server SHALL listen on `config.port`

### Requirement: S3 persistence configuration

The config schema SHALL accept the following environment variables for S3 backend configuration:

| Env Var | Required | Description |
|---------|----------|-------------|
| `PERSISTENCE_S3_BUCKET` | Yes (for S3) | S3 bucket name |
| `PERSISTENCE_S3_ACCESS_KEY_ID` | Yes (for S3) | Access key ID |
| `PERSISTENCE_S3_SECRET_ACCESS_KEY` | Yes (for S3) | Secret access key |
| `PERSISTENCE_S3_ENDPOINT` | No | Custom endpoint URL (for MinIO, R2, etc.) |
| `PERSISTENCE_S3_REGION` | No | AWS region |

All S3 fields SHALL be optional at the schema level. Validation of required S3 fields (bucket, credentials) SHALL occur when the S3 backend is selected.

`PERSISTENCE_S3_ACCESS_KEY_ID` and `PERSISTENCE_S3_SECRET_ACCESS_KEY` SHALL be returned as `Secret`-wrapped values (see "Secret wrapper for sensitive config values"). All other S3 fields SHALL be returned as plain strings. Consumers that need the cleartext credential (notably `createS3Storage`) SHALL call `.reveal()` at the point of use; no other code path SHALL reveal the value.

#### Scenario: S3 config fully provided

- **WHEN** `createConfig` is called with `{ WORKFLOW_DIR: "/app", PERSISTENCE_S3_BUCKET: "my-bucket", PERSISTENCE_S3_ACCESS_KEY_ID: "key", PERSISTENCE_S3_SECRET_ACCESS_KEY: "secret" }`
- **THEN** it SHALL return a config with `persistenceS3Bucket: "my-bucket"`
- **AND** `persistenceS3AccessKeyId.reveal()` SHALL equal `"key"`
- **AND** `persistenceS3SecretAccessKey.reveal()` SHALL equal `"secret"`

#### Scenario: S3 credentials redact on serialization

- **WHEN** `createConfig` is called with valid S3 config including `PERSISTENCE_S3_SECRET_ACCESS_KEY: "supersecret"`
- **AND** the resulting config object is serialized via `JSON.stringify`
- **THEN** the output SHALL NOT contain the substring `"supersecret"`
- **AND** the output SHALL contain `"[redacted]"` in place of the credential values

#### Scenario: S3 config with optional fields

- **WHEN** `createConfig` is called with S3 bucket, credentials, and `{ PERSISTENCE_S3_ENDPOINT: "http://minio:9000", PERSISTENCE_S3_REGION: "eu-central-1" }`
- **THEN** it SHALL return a config with `persistenceS3Endpoint: "http://minio:9000"` and `persistenceS3Region: "eu-central-1"`

#### Scenario: No S3 config provided

- **WHEN** `createConfig` is called without any `PERSISTENCE_S3_*` variables
- **THEN** all S3 config fields SHALL be `undefined`

#### Scenario: Bucket set without credentials

- **WHEN** `createConfig` is called with `PERSISTENCE_S3_BUCKET` set but either `PERSISTENCE_S3_ACCESS_KEY_ID` or `PERSISTENCE_S3_SECRET_ACCESS_KEY` missing
- **THEN** it SHALL throw a validation error indicating that bucket usage requires both credentials

### Requirement: Backend selection is mutually exclusive

If both `PERSISTENCE_PATH` and `PERSISTENCE_S3_BUCKET` are set, the config SHALL reject the configuration with a validation error.

#### Scenario: Both FS and S3 configured

- **WHEN** `createConfig` is called with both `PERSISTENCE_PATH` and `PERSISTENCE_S3_BUCKET` set
- **THEN** it SHALL throw a validation error indicating only one persistence backend can be configured

### Requirement: BASE_URL configuration
The config schema SHALL accept an optional `BASE_URL` environment variable. It SHALL be a string and SHALL have no default value. When provided, it SHALL be available as `baseUrl` in the config object.

#### Scenario: BASE_URL is set
- **WHEN** `createConfig` is called with `{ BASE_URL: "https://workflows.example.com" }`
- **THEN** the config SHALL contain `baseUrl: "https://workflows.example.com"`

#### Scenario: BASE_URL is not set
- **WHEN** `createConfig` is called without `BASE_URL`
- **THEN** `baseUrl` SHALL be `undefined`

#### Scenario: BASE_URL with HTTP
- **WHEN** `createConfig` is called with `{ BASE_URL: "http://localhost:8080" }`
- **THEN** the config SHALL contain `baseUrl: "http://localhost:8080"`

### Requirement: Secret wrapper for sensitive config values

The runtime SHALL expose a `Secret` value type produced by a `createSecret(value: string): Secret` factory for wrapping config fields that originate from K8s Secrets.

A `Secret` SHALL redact its underlying value whenever it is serialized or coerced to a string. Specifically:

- `JSON.stringify(secret)` SHALL yield the JSON string `"[redacted]"`.
- `String(secret)` and template-literal interpolation of `secret` SHALL yield `"[redacted]"`.
- `util.inspect(secret)` (and therefore `console.log(secret)`) SHALL yield `"[redacted]"`.

The cleartext value SHALL be reachable only by calling `secret.reveal()`, which returns the captured string. `reveal()` SHALL be idempotent.

#### Scenario: Secret redacts on JSON serialization

- **WHEN** `JSON.stringify(createSecret("abc"))` is evaluated
- **THEN** the result SHALL be the string `"\"[redacted]\""`

#### Scenario: Secret redacts on string coercion

- **WHEN** `String(createSecret("abc"))` or `` `${createSecret("abc")}` `` is evaluated
- **THEN** the result SHALL be `"[redacted]"`

#### Scenario: Secret redacts on util.inspect

- **WHEN** `util.inspect(createSecret("abc"))` is evaluated
- **THEN** the result SHALL be `"[redacted]"`

#### Scenario: Secret reveals on explicit request

- **WHEN** `createSecret("abc").reveal()` is evaluated
- **THEN** the result SHALL be the string `"abc"`

### Requirement: Dockerfile sets WORKFLOW_DIR default

The `infrastructure/Dockerfile` SHALL set `ENV WORKFLOW_DIR=/workflows` so the runtime uses the baked-in workflow bundles by default. This value MAY be overridden at container start time.

#### Scenario: Default WORKFLOW_DIR in image

- **WHEN** the container is started without explicitly setting `WORKFLOW_DIR`
- **THEN** the runtime SHALL use `/workflows` as the workflow directory

#### Scenario: Override WORKFLOW_DIR

- **WHEN** the container is started with `WORKFLOW_DIR=/custom/path`
- **THEN** the runtime SHALL use `/custom/path` instead of the default

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. This capability owns runtime configuration
values that gate security-relevant behavior — notably `AUTH_ALLOW`,
which controls whether the API authentication middleware is
registered at all.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add new configuration gates that enable or
disable authentication or authorization, change the interpretation of
existing security-relevant config values, or conflict with the rules
listed in `/SECURITY.md §4` MUST update `/SECURITY.md §4` in the same
change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §4`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §4`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §4`
- **THEN** no update to `/SECURITY.md §4` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked

### Requirement: AUTH_ALLOW config variable

The config schema SHALL accept an optional `AUTH_ALLOW` environment variable and expose its parsed result as a discriminated union `auth`:

```
auth:
  | { mode: "disabled" }
  | { mode: "open" }
  | { mode: "restricted"; users: Set<string>; orgs: Set<string> }
```

Resolution rules:
- `AUTH_ALLOW` is unset (undefined) or an empty string → `auth = { mode: "disabled" }`.
- `AUTH_ALLOW` equals the sentinel string `__DISABLE_AUTH__` → `auth = { mode: "open" }`.
- Any other parseable value → `auth = { mode: "restricted", users, orgs }`.

The value SHALL be parsed per the grammar and validation rules defined in the `auth` capability's "AUTH_ALLOW grammar" requirement. Unparseable values (unknown provider, unknown kind, invalid identifier, malformed structure) SHALL cause `createConfig` to throw a validation error at startup; the runtime SHALL fail to start with a diagnostic that identifies the first offending token.

The sentinel `__DISABLE_AUTH__` SHALL be valid only when it is the entire value of `AUTH_ALLOW`. If it appears as a semicolon-separated segment alongside other entries, `createConfig` SHALL throw a validation error indicating the sentinel must be the only value.

`AUTH_ALLOW` SHALL be returned as a plain (non-secret) config field. Allowlist contents are visible in pod specs and Kubernetes events for auditability.

#### Scenario: AUTH_ALLOW unset produces disabled mode

- **WHEN** `createConfig` is called without `AUTH_ALLOW`
- **THEN** the config SHALL contain `auth: { mode: "disabled" }`

#### Scenario: Sentinel produces open mode

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "__DISABLE_AUTH__" }`
- **THEN** the config SHALL contain `auth: { mode: "open" }`

#### Scenario: Parseable list produces restricted mode

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "github:user:alice;github:org:acme" }`
- **THEN** the config SHALL contain `auth: { mode: "restricted", users: Set(["alice"]), orgs: Set(["acme"]) }`

#### Scenario: Unknown provider fails startup

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "google:user:alice" }`
- **THEN** `createConfig` SHALL throw a validation error identifying `google` as an unknown provider

#### Scenario: Sentinel mixed with entries fails startup

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "github:user:alice;__DISABLE_AUTH__" }`
- **THEN** `createConfig` SHALL throw a validation error indicating the sentinel must be the only value

### Requirement: GitHub OAuth App credentials

The config schema SHALL accept two environment variables that provide the GitHub OAuth App's credentials used to drive the in-app OAuth handshake:

- `GITHUB_OAUTH_CLIENT_ID` — the OAuth App's client id (plain string).
- `GITHUB_OAUTH_CLIENT_SECRET` — the OAuth App's client secret (wrapped via `createSecret()`; callers that need the cleartext SHALL call `.reveal()` at the point of use, and no other code path SHALL reveal the value).

Both variables SHALL be optional at the schema level. Validation of their presence SHALL occur at auth initialisation:

- When `auth.mode === "restricted"`, both variables MUST be set; otherwise `createConfig` SHALL throw a validation error identifying the missing field.
- When `auth.mode === "disabled"` or `auth.mode === "open"`, both variables MAY be unset.

#### Scenario: Restricted mode without client id fails startup

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "github:user:alice" }` and no `GITHUB_OAUTH_CLIENT_ID`
- **THEN** `createConfig` SHALL throw a validation error identifying `GITHUB_OAUTH_CLIENT_ID` as missing

#### Scenario: Restricted mode with both credentials succeeds

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "github:user:alice", GITHUB_OAUTH_CLIENT_ID: "cid", GITHUB_OAUTH_CLIENT_SECRET: "csecret" }`
- **THEN** the config SHALL contain `githubOauthClientId: "cid"`
- **AND** `githubOauthClientSecret.reveal()` SHALL equal `"csecret"`

#### Scenario: Disabled mode omits credentials

- **WHEN** `createConfig` is called without `AUTH_ALLOW` and without either OAuth credential
- **THEN** `createConfig` SHALL succeed with `auth: { mode: "disabled" }`

#### Scenario: Client secret redacts on serialization

- **WHEN** `createConfig` is called with valid auth config including `GITHUB_OAUTH_CLIENT_SECRET: "supersecret"`
- **AND** the resulting config object is serialized via `JSON.stringify`
- **THEN** the output SHALL NOT contain the substring `"supersecret"`
- **AND** the output SHALL contain `"[redacted]"` in place of the secret value

