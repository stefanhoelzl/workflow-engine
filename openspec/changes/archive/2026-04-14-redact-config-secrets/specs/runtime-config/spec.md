## ADDED Requirements

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

All S3 fields SHALL be optional at the schema level. Validation of required S3 fields (bucket, credentials) SHALL occur when the S3 backend is selected.

`PERSISTENCE_S3_ACCESS_KEY_ID` and `PERSISTENCE_S3_SECRET_ACCESS_KEY` SHALL be returned as `Secret`-wrapped values (see "Secret wrapper for sensitive config values"). All other S3 fields SHALL be returned as plain strings. Consumers that need the cleartext credential (notably `createS3Storage`) SHALL call `.reveal()` at the point of use; no other code path SHALL reveal the value.

#### Scenario: S3 config fully provided

- **WHEN** `createConfig` is called with `{ PERSISTENCE_S3_BUCKET: "my-bucket", PERSISTENCE_S3_ACCESS_KEY_ID: "key", PERSISTENCE_S3_SECRET_ACCESS_KEY: "secret" }`
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
