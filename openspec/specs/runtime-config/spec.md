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

### Requirement: GITHUB_USER config variable

The config schema SHALL accept an optional `GITHUB_USER` environment variable. When provided, the GitHub authentication middleware SHALL be enabled on `/api/*` routes.

#### Scenario: GITHUB_USER is set

- **WHEN** `createConfig` is called with `{ GITHUB_USER: "stefanhoelzl" }`
- **THEN** the config SHALL contain `githubUser: "stefanhoelzl"`

#### Scenario: GITHUB_USER is not set

- **WHEN** `createConfig` is called without `GITHUB_USER`
- **THEN** `githubUser` SHALL be `undefined`

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

#### Scenario: S3 config fully provided

- **WHEN** `createConfig` is called with `{ WORKFLOW_DIR: "/app", PERSISTENCE_S3_BUCKET: "my-bucket", PERSISTENCE_S3_ACCESS_KEY_ID: "key", PERSISTENCE_S3_SECRET_ACCESS_KEY: "secret" }`
- **THEN** it SHALL return a config with `persistenceS3Bucket: "my-bucket"`, `persistenceS3AccessKeyId: "key"`, `persistenceS3SecretAccessKey: "secret"`

#### Scenario: S3 config with optional fields

- **WHEN** `createConfig` is called with S3 bucket, credentials, and `{ PERSISTENCE_S3_ENDPOINT: "http://minio:9000", PERSISTENCE_S3_REGION: "eu-central-1" }`
- **THEN** it SHALL return a config with `persistenceS3Endpoint: "http://minio:9000"` and `persistenceS3Region: "eu-central-1"`

#### Scenario: No S3 config provided

- **WHEN** `createConfig` is called without any `PERSISTENCE_S3_*` variables
- **THEN** all S3 config fields SHALL be `undefined`

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

### Requirement: Dockerfile sets WORKFLOW_DIR default

The `infrastructure/Dockerfile` SHALL set `ENV WORKFLOW_DIR=/workflows` so the runtime uses the baked-in workflow bundles by default. This value MAY be overridden at container start time.

#### Scenario: Default WORKFLOW_DIR in image

- **WHEN** the container is started without explicitly setting `WORKFLOW_DIR`
- **THEN** the runtime SHALL use `/workflows` as the workflow directory

#### Scenario: Override WORKFLOW_DIR

- **WHEN** the container is started with `WORKFLOW_DIR=/custom/path`
- **THEN** the runtime SHALL use `/custom/path` instead of the default
