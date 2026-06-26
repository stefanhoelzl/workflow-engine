## ADDED Requirements

### Requirement: STORAGE_BACKEND selection variable

The config schema SHALL accept an optional `STORAGE_BACKEND` environment variable exposed on the config object as `storageBackend`, defaulting to `"fs"` when unset. It selects which `StorageBackend` implementation the runtime constructs (see the `storage-backend` capability's "Backend construction" requirement). The schema SHALL accept `"fs"`; any other value SHALL be carried through unmodified so that the backend factory rejects it at construction with a single, descriptive failure (rather than the config layer and the factory each owning a partial list of valid backends). `PERSISTENCE_PATH` remains the mandatory filesystem root regardless of this value.

#### Scenario: Defaults to fs when unset

- **WHEN** `createConfig` is called without `STORAGE_BACKEND`
- **THEN** the result SHALL have `storageBackend: "fs"`

#### Scenario: Explicit fs value accepted

- **WHEN** `createConfig` is called with `{ STORAGE_BACKEND: "fs" }`
- **THEN** the result SHALL have `storageBackend: "fs"`
