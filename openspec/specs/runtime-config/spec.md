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

Secret-sourced config fields SHALL compose `createSecret` into the field's Zod schema via `.transform(createSecret)` so the value on the returned config object is a `Secret`-wrapped type at the schema boundary (canonical examples: `GITHUB_OAUTH_CLIENT_SECRET`, `PERSISTENCE_S3_ACCESS_KEY_ID`, `PERSISTENCE_S3_SECRET_ACCESS_KEY` in `packages/runtime/src/config.ts`). Non-secret config fields (e.g. `AUTH_ALLOW`, `LOG_LEVEL`, `PORT`, `BASE_URL`, `PERSISTENCE_S3_BUCKET`, `PERSISTENCE_S3_ENDPOINT`, `PERSISTENCE_S3_REGION`, `LOCAL_DEPLOYMENT`) SHALL NOT be `Secret`-wrapped — they are visible in pod specs and logs by design.

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

### Requirement: AUTH_ALLOW config variable (deferred validation model)

The config schema SHALL accept an optional `AUTH_ALLOW` environment variable as an untyped `string | undefined` and expose it verbatim on the returned config object as `authAllow`. The schema SHALL NOT parse the grammar, look up provider factories, or reject entries at the `createConfig` boundary — that responsibility is deferred to `buildRegistry` (see the `auth` capability's `AuthProviderFactory and provider registry` requirement).

The deferred model is load-bearing: registry construction requires per-request deps (`secureCookies`, `nowFn`, revealed OAuth credentials) that `createConfig` has no business seeing, and provider-specific grammars (`github`, `local`) are owned by each `factory.create` method per the auth capability spec. A `.refine()` in the schema would either re-implement that dispatch or force the deps through the env-parsing boundary; both are non-goals.

The parsing pipeline is therefore:

1. `createConfig(env)` returns `{ authAllow: env.AUTH_ALLOW, localDeployment: env.LOCAL_DEPLOYMENT, ... }`. It NEVER throws on `AUTH_ALLOW` content.
2. `main.ts` calls `buildProviderFactories(process.env)` (reads `LOCAL_DEPLOYMENT`), then `buildRegistry(config.authAllow, factories, deps)` where:
   - Top-level entries SHALL be separated by `,` (whitespace-trimmed, empty segments skipped).
   - Each entry SHALL be split on its first `:` only, yielding `(ProviderId, ProviderRest)`.
   - `ProviderRest` SHALL be dispatched to the registered provider's `factory.create` method, which owns provider-specific grammar validation (see `auth/spec.md` — `AUTH_ALLOW grammar` requirement for the formal grammar).
   - `ProviderId` values not matching any registered factory SHALL cause `buildRegistry` to throw `unknown provider "<id>"`. This error surfaces during `main.ts` startup and aborts the process before the HTTP server binds.

The practical guarantee is identical to eager validation (invalid `AUTH_ALLOW` aborts startup before any request is served); only the stack frame differs. Operators SHOULD treat `buildRegistry` errors as config errors for the purposes of troubleshooting.

There SHALL NOT be a sentinel value for "auth disabled". Empty/unset `AUTH_ALLOW` SHALL yield an empty provider registry; the runtime SHALL start successfully but the login page SHALL render with no provider sections, and every protected route SHALL respond `401`/`302` because no provider can resolve identity.

The `__DISABLE_AUTH__` sentinel SHALL NOT be recognized — operators upgrading from a prior runtime version SHALL replace it with one or more `local:<name>` entries plus `LOCAL_DEPLOYMENT=1` (dev only) or with `github:*` entries (prod).

`AUTH_ALLOW` SHALL be returned as a plain (non-secret) config field. Allowlist contents are visible in pod specs and Kubernetes events for auditability; in particular, `AUTH_ALLOW` SHALL NOT be wrapped by `createSecret()` and is an explicit exception to the "secrets travel via K8s Secret + `envFrom.secretRef` + `Secret` wrapper" chain (see `Secret wrapper for sensitive config values` requirement and `/SECURITY.md §5`).

#### Scenario: AUTH_ALLOW unset leaves authAllow undefined

- **WHEN** `createConfig` is called without `AUTH_ALLOW`
- **THEN** the returned config SHALL have `authAllow: undefined`
- **AND** `createConfig` SHALL NOT throw

#### Scenario: AUTH_ALLOW passes through unparsed

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,local:dev"`
- **THEN** the returned config SHALL have `authAllow: "github:user:alice,local:dev"` (exact string, unparsed)
- **AND** `createConfig` SHALL NOT throw regardless of provider-id validity

#### Scenario: Unknown provider aborts startup in buildRegistry

- **GIVEN** `createConfig` was called with `AUTH_ALLOW = "google:user:alice"` and returned `{ authAllow: "google:user:alice" }`
- **WHEN** `main.ts` subsequently calls `buildRegistry("google:user:alice", factories, deps)`
- **THEN** `buildRegistry` SHALL throw `unknown provider "google"`
- **AND** the process SHALL abort before the HTTP server binds

#### Scenario: __DISABLE_AUTH__ is no longer recognized

- **WHEN** `buildRegistry` is called with `"__DISABLE_AUTH__"`
- **THEN** it SHALL throw `unknown provider "__DISABLE_AUTH__"` (no factory registers that id)

#### Scenario: Empty AUTH_ALLOW yields empty registry

- **WHEN** `buildRegistry` is called with `undefined` or `""`
- **THEN** the runtime SHALL start successfully
- **AND** the resulting registry SHALL contain zero providers

#### Scenario: github entries register the github provider

- **WHEN** `buildRegistry` is called with `"github:user:alice,github:org:acme"` and the github factory is registered
- **THEN** the registry SHALL contain a provider with id `"github"` whose internal entries represent users `{"alice"}` and orgs `{"acme"}`

#### Scenario: Mixed providers register independently

- **GIVEN** `LOCAL_DEPLOYMENT="1"` and both `github` + `local` factories are registered
- **WHEN** `buildRegistry` is called with `"github:user:alice,local:dev"`
- **THEN** the registry SHALL contain providers with ids `"github"` and `"local"`

### Requirement: LOCAL_DEPLOYMENT enables the local auth provider factory

The runtime SHALL read `process.env.LOCAL_DEPLOYMENT` and treat the value `"1"` as a hard gate for registering the `localProviderFactory` in the auth-provider list.

When `LOCAL_DEPLOYMENT === "1"`, both `githubProviderFactory` and `localProviderFactory` SHALL be available to the registry build.

When `LOCAL_DEPLOYMENT` is unset, set to the empty string, or set to any value other than the literal `"1"`, only `githubProviderFactory` SHALL be available. Any `local:*` entry in `AUTH_ALLOW` SHALL cause `buildRegistry` to fail startup with `unknown provider "local"` — the same error class as a typo, with no special-case treatment. (Per the deferred-validation model, this error surfaces inside `buildRegistry` during `main.ts` startup; `createConfig` itself NEVER rejects `AUTH_ALLOW` content.)

`LOCAL_DEPLOYMENT` SHALL also continue to gate the HSTS exemption in `secure-headers.ts` (existing behavior, unchanged).

#### Scenario: LOCAL_DEPLOYMENT=1 makes local provider available

- **GIVEN** `LOCAL_DEPLOYMENT=1`
- **WHEN** the runtime starts with `AUTH_ALLOW = "local:dev"`
- **THEN** the runtime SHALL start successfully
- **AND** the registry SHALL contain a provider with id `"local"`

#### Scenario: LOCAL_DEPLOYMENT unset rejects local entries

- **GIVEN** `LOCAL_DEPLOYMENT` is unset
- **WHEN** the runtime starts with `AUTH_ALLOW = "local:dev"`
- **THEN** `createConfig` SHALL succeed (deferred validation)
- **AND** the subsequent `buildRegistry` call SHALL throw `unknown provider "local"` and abort startup

#### Scenario: LOCAL_DEPLOYMENT=0 rejects local entries

- **GIVEN** `LOCAL_DEPLOYMENT="0"`
- **WHEN** the runtime starts with `AUTH_ALLOW = "local:dev"`
- **THEN** `buildRegistry` SHALL throw `unknown provider "local"` and abort startup

#### Scenario: LOCAL_DEPLOYMENT=1 alone does not register a provider

- **GIVEN** `LOCAL_DEPLOYMENT=1` and `AUTH_ALLOW` unset
- **WHEN** the runtime starts
- **THEN** the runtime SHALL start successfully with an empty registry
- **AND** the local provider SHALL NOT be registered (factory available, but no entries to bucket)

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

### Requirement: SECRETS_PRIVATE_KEYS config field

The runtime config SHALL expose a required `SECRETS_PRIVATE_KEYS` field populated from the env var of the same name. The value SHALL be parsed as a comma-separated list of `keyId:base64(sk)` entries where each `sk` decodes to exactly 32 bytes. The parsed form SHALL be wrapped via `createSecret()` so that the config object never exposes the raw bytes when serialized, stringified, or logged.

The runtime SHALL fail startup (via `createConfig` throw) if the env var is missing, empty, malformed, contains any entry with the wrong secret-key length, or has no entries. The primary (active sealing) key SHALL be the first entry in the list.

#### Scenario: Valid env var parses into config

- **GIVEN** `SECRETS_PRIVATE_KEYS="k1:<valid-b64-32>"`
- **WHEN** `createConfig(env)` is called
- **THEN** `config.SECRETS_PRIVATE_KEYS` SHALL be a `Secret` wrapping the parsed value
- **AND** `config.SECRETS_PRIVATE_KEYS.reveal()` SHALL yield the internal parsed representation

#### Scenario: Missing env var fails startup

- **GIVEN** no `SECRETS_PRIVATE_KEYS` is set
- **WHEN** `createConfig(env)` is called
- **THEN** it SHALL throw an error identifying the missing field

#### Scenario: Malformed entry fails startup

- **GIVEN** `SECRETS_PRIVATE_KEYS="bad-entry-no-colon"`
- **WHEN** `createConfig(env)` is called
- **THEN** it SHALL throw an error naming the malformed entry

#### Scenario: Wrong secret-key length fails startup

- **GIVEN** `SECRETS_PRIVATE_KEYS="k1:<b64-of-16-bytes>"`
- **WHEN** `createConfig(env)` is called
- **THEN** it SHALL throw with an error referencing the invalid secret-key length

#### Scenario: Config field is redacted when serialized

- **GIVEN** a valid config
- **WHEN** `JSON.stringify(config)` or `console.log(config.SECRETS_PRIVATE_KEYS)` is invoked
- **THEN** the output SHALL contain `"[redacted]"` where the secret value would be
- **AND** SHALL NOT contain any plaintext byte from any secret key

### Requirement: SANDBOX_MAX_COUNT config variable

`createConfig` SHALL accept an optional `SANDBOX_MAX_COUNT` environment variable. Its value SHALL be coerced from string to a positive integer. It SHALL default to `10` when not provided. The parsed value SHALL be exposed on the returned config object as `sandboxMaxCount: number`.

The variable is non-secret and is intentionally visible in pod specifications for auditability (consistent with the existing `AUTH_ALLOW` carve-out); it SHALL NOT be wrapped by `createSecret`.

Semantically, `sandboxMaxCount` is the soft cap on resident `(owner, workflow.sha)` sandboxes held by the runtime's sandbox cache (see `executor/spec.md` "Sandbox cache is bounded by SANDBOX_MAX_COUNT"). The runtime SHALL pass this value through to `createSandboxStore`.

#### Scenario: Default value

- **WHEN** `createConfig` is called with an environment that does NOT set `SANDBOX_MAX_COUNT`
- **THEN** the returned config SHALL have `sandboxMaxCount` equal to `10`

#### Scenario: Explicit value parsed

- **WHEN** `createConfig` is called with `{ SANDBOX_MAX_COUNT: "25" }`
- **THEN** the returned config SHALL have `sandboxMaxCount` equal to `25` (number)

#### Scenario: Non-numeric value rejected

- **WHEN** `createConfig` is called with `{ SANDBOX_MAX_COUNT: "abc" }`
- **THEN** it SHALL throw a validation error

#### Scenario: Non-positive value rejected

- **WHEN** `createConfig` is called with `{ SANDBOX_MAX_COUNT: "0" }` or `{ SANDBOX_MAX_COUNT: "-3" }`
- **THEN** it SHALL throw a validation error

### Requirement: Sandbox resource-limit config fields

The runtime config schema in `packages/runtime/src/config.ts` SHALL define five sandbox resource-limit fields, each sourced from an environment variable and coerced to a positive integer. Defaults SHALL live in the zod schema via `.default(...)`; no Dockerfile `ENV` line SHALL set these values. Operators override the defaults by setting the corresponding environment variable in K8s manifests.

The fields SHALL be:

| Env variable | Zod shape | Default | Meaning |
|---|---|---|---|
| `SANDBOX_LIMIT_MEMORY_BYTES` | `z.coerce.number().int().positive().default(67_108_864)` | 64 MiB | QuickJS heap cap per sandbox |
| `SANDBOX_LIMIT_STACK_BYTES` | `z.coerce.number().int().positive().default(524_288)` | 512 KiB | QuickJS `maxStackSize` per sandbox |
| `SANDBOX_LIMIT_CPU_MS` | `z.coerce.number().int().positive().default(60_000)` | 60 s | Wall-clock cap per `sandbox.run()` |
| `SANDBOX_LIMIT_OUTPUT_BYTES` | `z.coerce.number().int().positive().default(4_194_304)` | 4 MiB | Cumulative event-stream bytes per run |
| `SANDBOX_LIMIT_PENDING_CALLABLES` | `z.coerce.number().int().positive().default(64)` | 64 | Concurrent in-flight host-callables per run |

The runtime's `main.ts` SHALL thread these values into the sandbox factory's `create({ memoryBytes, stackBytes, cpuMs, outputBytes, pendingCallables, ... })` options. No call site outside `main.ts` SHALL read these env vars directly from `process.env`.

The config fields SHALL NOT be wrapped with `createSecret` (they are non-secret operational limits; see the auditability carve-out under the existing `AUTH_ALLOW` requirement).

#### Scenario: Defaults apply when env vars are unset

- **GIVEN** a runtime process started with none of the `SANDBOX_LIMIT_*` env vars set
- **WHEN** `loadConfig()` is called
- **THEN** the returned config SHALL carry `SANDBOX_LIMIT_MEMORY_BYTES = 67108864`, `SANDBOX_LIMIT_STACK_BYTES = 524288`, `SANDBOX_LIMIT_CPU_MS = 60000`, `SANDBOX_LIMIT_OUTPUT_BYTES = 4194304`, `SANDBOX_LIMIT_PENDING_CALLABLES = 64`

#### Scenario: Env-var override replaces default

- **GIVEN** a runtime process started with `SANDBOX_LIMIT_CPU_MS=5000`
- **WHEN** `loadConfig()` is called
- **THEN** the returned config SHALL carry `SANDBOX_LIMIT_CPU_MS = 5000`

#### Scenario: Non-positive value rejected

- **GIVEN** a runtime process started with `SANDBOX_LIMIT_MEMORY_BYTES=0` or `SANDBOX_LIMIT_MEMORY_BYTES=-1`
- **WHEN** `loadConfig()` is called
- **THEN** the schema SHALL reject the value and startup SHALL fail with a clear error message

#### Scenario: Non-numeric value rejected

- **GIVEN** a runtime process started with `SANDBOX_LIMIT_CPU_MS=abc`
- **WHEN** `loadConfig()` is called
- **THEN** the schema SHALL reject the value and startup SHALL fail

