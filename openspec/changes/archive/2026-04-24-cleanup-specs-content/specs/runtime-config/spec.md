## ADDED Requirements

### Requirement: FILE_IO_CONCURRENCY config variable

The config schema SHALL accept a `FILE_IO_CONCURRENCY` environment variable (integer coerced from a string via `z.coerce.number()`) with a default of `10`. The value SHALL be exposed on the config object as `fileIoConcurrency`. This bound is applied by the runtime's FS-backed storage backend to cap the number of concurrent disk I/O operations.

#### Scenario: Default value

- **WHEN** `createConfig` is called without `FILE_IO_CONCURRENCY`
- **THEN** the result SHALL have `fileIoConcurrency: 10`

#### Scenario: Override

- **WHEN** `createConfig` is called with `{ FILE_IO_CONCURRENCY: "32" }`
- **THEN** the result SHALL have `fileIoConcurrency: 32`

#### Scenario: Non-numeric value rejected

- **WHEN** `createConfig` is called with `{ FILE_IO_CONCURRENCY: "abc" }`
- **THEN** `createConfig` SHALL throw a validation error

### Requirement: LOCAL_DEPLOYMENT is a typed config field

The config schema SHALL accept an optional `LOCAL_DEPLOYMENT` environment variable exposed on the config object as `localDeployment` (plain string; no `z.coerce.boolean()`). Downstream callers SHALL compare it to the literal `"1"` to derive a boolean posture (`localDeployment === "1"` is the "local dev" posture; any other value or unset is the "hardened" posture).

This field gates (a) the local auth provider factory inclusion in `buildProviderFactories` (see `LOCAL_DEPLOYMENT enables the local auth provider factory` requirement), (b) the `secureCookies` posture used when building the auth registry (secure cookies ON when not local), and (c) the HSTS exemption in `secure-headers.ts` (HSTS header emitted only when NOT local).

#### Scenario: LOCAL_DEPLOYMENT=1 exposed in config

- **WHEN** `createConfig` is called with `{ LOCAL_DEPLOYMENT: "1" }`
- **THEN** the result SHALL have `localDeployment: "1"`

#### Scenario: Unset LOCAL_DEPLOYMENT

- **WHEN** `createConfig` is called without `LOCAL_DEPLOYMENT`
- **THEN** the result SHALL have `localDeployment: undefined`

## MODIFIED Requirements

### Requirement: S3 persistence configuration

The config schema SHALL accept the following environment variables for S3 backend configuration:

| Env Var | Required | Description |
|---------|----------|-------------|
| `PERSISTENCE_S3_BUCKET` | Yes (for S3) | S3 bucket name |
| `PERSISTENCE_S3_ACCESS_KEY_ID` | Yes (for S3) | Access key ID |
| `PERSISTENCE_S3_SECRET_ACCESS_KEY` | Yes (for S3) | Secret access key |
| `PERSISTENCE_S3_ENDPOINT` | No | Custom endpoint URL (for MinIO, R2, etc.) |
| `PERSISTENCE_S3_REGION` | No | AWS region |

All S3 fields SHALL be optional at the schema level. The schema SHALL apply a refine rule that rejects a configuration where `PERSISTENCE_S3_BUCKET` is set but either `PERSISTENCE_S3_ACCESS_KEY_ID` or `PERSISTENCE_S3_SECRET_ACCESS_KEY` is missing.

`PERSISTENCE_S3_ACCESS_KEY_ID` and `PERSISTENCE_S3_SECRET_ACCESS_KEY` SHALL be returned as `Secret`-wrapped values (see "Secret wrapper for sensitive config values"). All other S3 fields SHALL be returned as plain strings. Consumers that need the cleartext credential (notably `createS3Storage`) SHALL call `.reveal()` at the point of use.

#### Scenario: S3 config fully provided

- **WHEN** `createConfig` is called with `{ PERSISTENCE_S3_BUCKET: "my-bucket", PERSISTENCE_S3_ACCESS_KEY_ID: "key", PERSISTENCE_S3_SECRET_ACCESS_KEY: "secret" }`
- **THEN** the result SHALL have `persistenceS3Bucket: "my-bucket"`
- **AND** `persistenceS3AccessKeyId.reveal()` SHALL equal `"key"`
- **AND** `persistenceS3SecretAccessKey.reveal()` SHALL equal `"secret"`

#### Scenario: S3 credentials redact on serialization

- **WHEN** `createConfig` is called with valid S3 config including `PERSISTENCE_S3_SECRET_ACCESS_KEY: "supersecret"`
- **AND** the resulting config object is serialized via `JSON.stringify`
- **THEN** the output SHALL NOT contain the substring `"supersecret"`
- **AND** the output SHALL contain `"[redacted]"` in place of the credential values

#### Scenario: S3 config with optional fields

- **WHEN** `createConfig` is called with S3 bucket, credentials, and `{ PERSISTENCE_S3_ENDPOINT: "http://minio:9000", PERSISTENCE_S3_REGION: "eu-central-1" }`
- **THEN** the result SHALL have `persistenceS3Endpoint: "http://minio:9000"` and `persistenceS3Region: "eu-central-1"`

#### Scenario: No S3 config provided

- **WHEN** `createConfig` is called without any `PERSISTENCE_S3_*` variables
- **THEN** all S3 config fields SHALL be `undefined`

#### Scenario: Bucket set without credentials

- **WHEN** `createConfig` is called with `PERSISTENCE_S3_BUCKET` set but either `PERSISTENCE_S3_ACCESS_KEY_ID` or `PERSISTENCE_S3_SECRET_ACCESS_KEY` missing
- **THEN** `createConfig` SHALL throw a validation error identifying the missing credential

### Requirement: GitHub OAuth App credentials

The config schema SHALL accept two optional environment variables that provide the GitHub OAuth App's credentials used to drive the in-app OAuth handshake:

- `GITHUB_OAUTH_CLIENT_ID` — the OAuth App's client id (plain string).
- `GITHUB_OAUTH_CLIENT_SECRET` — the OAuth App's client secret (wrapped via `createSecret()`; callers that need the cleartext SHALL call `.reveal()` at the point of use).

Both variables SHALL be optional at the SCHEMA level — `createConfig` does not enforce their presence. The runtime-side auth provider registry construction (in `main.ts`) passes these values into `buildRegistry` as optional fields; each provider factory decides whether they are required. The `github` provider's `factory.create` SHALL throw when `AUTH_ALLOW` includes one or more `github:*` entries but either credential is missing. The `local` provider SHALL have no such dependency.

Code paths that consume `githubOauthClientSecret` SHALL reveal it only where the cleartext is demonstrably necessary (currently only the OAuth token exchange inside `buildRegistry`).

#### Scenario: Config parses with no credentials

- **WHEN** `createConfig` is called without `GITHUB_OAUTH_CLIENT_ID` or `GITHUB_OAUTH_CLIENT_SECRET`
- **THEN** `createConfig` SHALL succeed
- **AND** the result SHALL have `githubOauthClientId: undefined` and `githubOauthClientSecret: undefined`

#### Scenario: Config parses with both credentials

- **WHEN** `createConfig` is called with `{ GITHUB_OAUTH_CLIENT_ID: "cid", GITHUB_OAUTH_CLIENT_SECRET: "csecret" }`
- **THEN** the config SHALL have `githubOauthClientId: "cid"`
- **AND** `githubOauthClientSecret.reveal()` SHALL equal `"csecret"`

#### Scenario: Missing credentials fail at registry construction, not config parsing

- **GIVEN** `AUTH_ALLOW = "github:user:alice"` and no `GITHUB_OAUTH_CLIENT_ID`
- **WHEN** `createConfig(env)` is called
- **THEN** `createConfig` SHALL succeed (the schema does not enforce credential presence)
- **AND** the subsequent `buildRegistry(...)` call in `main.ts` SHALL throw when the github provider factory encounters the `github:*` entry without its required credentials

#### Scenario: Client secret redacts on serialization

- **WHEN** `createConfig` is called with valid config including `GITHUB_OAUTH_CLIENT_SECRET: "supersecret"`
- **AND** the resulting config object is serialized via `JSON.stringify`
- **THEN** the output SHALL NOT contain the substring `"supersecret"`
- **AND** the output SHALL contain `"[redacted]"` in place of the secret value

## REMOVED Requirements

### Requirement: Dockerfile sets WORKFLOW_DIR default

**Reason**: `WORKFLOW_DIR` was removed by `multi-tenant-workflows`; the runtime no longer reads a filesystem directory for workflow bundles. Tenant bundles are loaded from the configured storage backend (`workflows/<tenant>.tar.gz`) at runtime. `infrastructure/Dockerfile` no longer sets this ENV.

**Migration**: None. Operators with legacy container images built before the `multi-tenant-workflows` change SHOULD rebuild; runtime ignores the variable if set. Bundle loading happens via `WorkflowRegistry` against the `StorageBackend` (FS or S3).
