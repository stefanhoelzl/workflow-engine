## ADDED Requirements

### Requirement: STORAGE_BUNNY_* config fields

The config schema SHALL accept three environment variables that configure the
Bunny Edge Storage backend, all **optional at the schema level** (the backend
factory enforces required-ness — see the `STORAGE_BACKEND selection variable`
requirement and the `storage-backend` capability's `StorageBackend factory`
requirement). Exposed on the config object as:

- `STORAGE_BUNNY_ENDPOINT` (plain string) — the Edge Storage origin host (e.g.
  `storage.bunnycdn.com`). Non-secret; visible in pod/container specs.
- `STORAGE_BUNNY_STORAGE_ZONE` (plain string) — the storage zone name. Non-secret.
- `STORAGE_BUNNY_ACCESS_KEY` (`Secret`-wrapped via `.transform(createSecret)`) —
  the zone's read-write access key. Secret-wrapping is a config concern and is
  applied regardless of which backend is selected; callers reveal it only at the
  point of use (the HTTP `AccessKey` header inside the Bunny backend).

The schema SHALL NOT cross-validate these against `STORAGE_BACKEND` (the config
layer does not enumerate backends). When `STORAGE_BACKEND` is not `bunny`, the
fields are simply carried through (or absent) and unused.

#### Scenario: Bunny fields parsed and access key Secret-wrapped

- **WHEN** `createConfig` is called with `{ STORAGE_BUNNY_ENDPOINT: "storage.bunnycdn.com", STORAGE_BUNNY_STORAGE_ZONE: "wfe-staging-bundles", STORAGE_BUNNY_ACCESS_KEY: "abc123", DATABASE_URL: "file:/data/events.db", PERSISTENCE_PATH: "/data", SECRETS_PRIVATE_KEYS: "v1:..." }`
- **THEN** the config SHALL have `storageBunnyEndpoint: "storage.bunnycdn.com"` and `storageBunnyStorageZone: "wfe-staging-bundles"`
- **AND** `storageBunnyAccessKey` SHALL be a `Secret`
- **AND** `storageBunnyAccessKey.reveal()` SHALL yield `"abc123"`

#### Scenario: Access key redacts on serialization

- **WHEN** a config carrying `STORAGE_BUNNY_ACCESS_KEY: "supersecret"` is serialized via `JSON.stringify`
- **THEN** the output SHALL NOT contain the substring `"supersecret"`
- **AND** the output SHALL contain `"[redacted]"` in place of the access key

#### Scenario: Bunny fields are optional regardless of backend

- **WHEN** `createConfig` is called without any `STORAGE_BUNNY_*` variable (and `STORAGE_BACKEND` unset)
- **THEN** `createConfig` SHALL succeed
- **AND** `storageBunnyEndpoint`, `storageBunnyStorageZone`, and `storageBunnyAccessKey` SHALL be `undefined`

## MODIFIED Requirements

### Requirement: STORAGE_BACKEND selection variable

The config schema SHALL accept an optional `STORAGE_BACKEND` environment variable exposed on the config object as `storageBackend`, defaulting to `"fs"` when unset. It selects which `StorageBackend` implementation the runtime constructs (see the `storage-backend` capability's `StorageBackend factory` requirement). The schema SHALL carry the value through unmodified — it SHALL NOT enumerate the set of valid backends, and it SHALL NOT cross-validate per-backend required configuration (such as the `STORAGE_BUNNY_*` fields). The backend factory owns both responsibilities: it rejects an unrecognised backend value and asserts that the selected backend's required config is present, each with a single descriptive boot-time failure. This keeps the config layer and the factory from each owning a partial backend list. `PERSISTENCE_PATH` remains the mandatory filesystem root regardless of this value.

#### Scenario: Defaults to fs when unset

- **WHEN** `createConfig` is called without `STORAGE_BACKEND`
- **THEN** the result SHALL have `storageBackend: "fs"`

#### Scenario: Explicit fs value accepted

- **WHEN** `createConfig` is called with `{ STORAGE_BACKEND: "fs" }`
- **THEN** the result SHALL have `storageBackend: "fs"`

#### Scenario: bunny value carried through unvalidated by the schema

- **WHEN** `createConfig` is called with `{ STORAGE_BACKEND: "bunny" }` and no `STORAGE_BUNNY_*` fields
- **THEN** `createConfig` SHALL succeed with `storageBackend: "bunny"` (the missing fields surface later, at factory construction, not at config parse)
