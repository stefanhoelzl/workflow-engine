## ADDED Requirements

### Requirement: Bunny Edge Storage backend

The system SHALL provide a Bunny Edge Storage `StorageBackend` implementation
created via an async factory `createBunnyStorage(config)` that accepts the
storage host (`STORAGE_BUNNY_ENDPOINT`), the zone name
(`STORAGE_BUNNY_STORAGE_ZONE`), and the access key (`STORAGE_BUNNY_ACCESS_KEY`,
revealed from its `Secret` wrapper at the point of use). It returns an
already-initialized backend (no separate `init` step). All requests go to the
Bunny Edge Storage HTTP **origin** (`https://<endpoint>/<zone>/<key>`) with the
`AccessKey` header; the backend SHALL NOT read or write through a CDN pull zone,
so a `read` after a `write` never observes a cached, stale object.

- `write(path, data)` SHALL issue an HTTP `PUT` of the raw bytes to the object
  URL. A successful `PUT` replaces the object atomically server-side; there is
  no `.tmp` staging artifact. A non-2xx response SHALL throw.
- `read(path)` SHALL issue an HTTP `GET`. On `200` it SHALL return a
  `Uint8Array` over the exact response bytes. On `404` it SHALL throw
  `NotFoundError`. Any other non-2xx response SHALL throw.
- `list(prefix)` SHALL recursively walk Bunny's per-directory JSON listings
  (a `GET` on a directory path returns a JSON array whose entries carry an
  `IsDirectory` flag) and SHALL yield every committed object key under `prefix`
  as an opaque forward-slash-delimited string with no leading slash. It SHALL
  recurse into directory entries and SHALL NOT yield directory entries
  themselves. List order is unspecified.
- Keys SHALL be treated as opaque forward-slash-delimited strings; the backend
  SHALL NOT reinterpret them as OS-native paths and SHALL NOT apply a key prefix
  beyond the zone name.
- The backend SHALL NOT retry: a transient `4xx`/`5xx`/network error surfaces to
  the caller on the first attempt. (`recover()` runs at boot; a transient failure
  there crashes the container, which Magic Containers restarts.)

#### Scenario: Byte-level write and read roundtrip over the mocked API

- **GIVEN** a Bunny backend whose HTTP layer is mocked (undici `MockAgent`)
- **AND** a `Uint8Array` containing arbitrary binary bytes (e.g. a gzip header `0x1f 0x8b 0x08 0x00`)
- **WHEN** `write("workflows/foo/bar.tar.gz", data)` issues a `PUT` and then `read("workflows/foo/bar.tar.gz")` issues a `GET` returning `200` with those bytes
- **THEN** `read` SHALL return a `Uint8Array` whose contents are identical to `data`

#### Scenario: read of a missing object throws NotFoundError

- **GIVEN** a Bunny backend whose mocked `GET` for `workflows/none/missing.tar.gz` returns `404`
- **WHEN** `read("workflows/none/missing.tar.gz")` is awaited
- **THEN** it SHALL reject with a `NotFoundError`

#### Scenario: list yields object keys recursively, not directories

- **GIVEN** a Bunny backend whose mocked listings expose `workflows/acme/foo.tar.gz` under the `workflows/` then `workflows/acme/` directories
- **WHEN** `list("workflows/")` is iterated
- **THEN** it SHALL yield `"workflows/acme/foo.tar.gz"`
- **AND** it SHALL NOT yield any directory entry (e.g. `"workflows/acme/"`)

#### Scenario: reads and writes target the storage origin, not a CDN URL

- **WHEN** the Bunny backend issues any request
- **THEN** the request URL host SHALL be the configured `STORAGE_BUNNY_ENDPOINT` storage origin
- **AND** SHALL NOT be a CDN pull-zone host

### Requirement: Bunny backend boot probe

`createBunnyStorage` SHALL perform a single lightweight connectivity/credentials
probe at construction (a `GET`/list of the zone root) so a misconfigured zone or
access key fails fast at boot rather than at first `read`/`write`. The probe
SHALL classify by HTTP status:

- `401` or `403` SHALL be treated as fatal (bad or missing access key): the
  factory SHALL throw and the runtime SHALL NOT begin serving.
- `200` (including an empty zone whose listing is an empty array) SHALL be
  treated as success: construction proceeds. A fresh, empty zone on first boot
  is a healthy state — `recover()` simply finds no bundles until the next upload.
- Any other non-2xx status SHALL be treated as fatal.

The probe SHALL NOT retry.

#### Scenario: Bad access key crashes the container at boot

- **GIVEN** a Bunny backend whose mocked zone-root probe returns `401`
- **WHEN** `createBunnyStorage(config)` is awaited
- **THEN** it SHALL reject (the runtime SHALL NOT begin serving)

#### Scenario: Empty zone is a healthy boot

- **GIVEN** a Bunny backend whose mocked zone-root probe returns `200` with an empty listing
- **WHEN** `createBunnyStorage(config)` is awaited
- **THEN** it SHALL resolve to a ready `StorageBackend`
- **AND** a subsequent `list("workflows/")` SHALL yield nothing without error

## MODIFIED Requirements

### Requirement: StorageBackend factory

The runtime SHALL construct its `StorageBackend` via an async `createStorage(config)` factory that selects the implementation by `config.storageBackend` (sourced from the `STORAGE_BACKEND` env var; see the `runtime-config` capability). For `"fs"` it SHALL return `await createFsStorage(config.persistencePath)` — the filesystem backend rooted at `PERSISTENCE_PATH`. For `"bunny"` it SHALL return `await createBunnyStorage(config)` — the Bunny Edge Storage backend constructed from the `STORAGE_BUNNY_*` config. The factory SHALL reject (fail fast at boot) when `config.storageBackend` is an unrecognised value.

The factory — not the `runtime-config` schema — owns per-backend required-config validation: when a backend needs configuration that the schema carries as optional (e.g. `bunny` needs `STORAGE_BUNNY_ENDPOINT`, `STORAGE_BUNNY_STORAGE_ZONE`, and `STORAGE_BUNNY_ACCESS_KEY`), the factory SHALL assert their presence and throw a descriptive boot error when any is missing. This keeps the backend registry in exactly one place. The filesystem factory `createFsStorage(path)` remains the fs implementation invoked by `createStorage`.

#### Scenario: FS backend constructed from PERSISTENCE_PATH

- **WHEN** the runtime starts with `STORAGE_BACKEND` unset (defaulting to `"fs"`) and `PERSISTENCE_PATH=/data/events`
- **THEN** `createStorage(config)` SHALL resolve to a filesystem `StorageBackend` rooted at `/data/events`

#### Scenario: Bunny backend constructed from STORAGE_BUNNY_* config

- **WHEN** the runtime starts with `STORAGE_BACKEND=bunny` and `STORAGE_BUNNY_ENDPOINT`, `STORAGE_BUNNY_STORAGE_ZONE`, and `STORAGE_BUNNY_ACCESS_KEY` all set
- **THEN** `createStorage(config)` SHALL resolve to a Bunny `StorageBackend` for that zone

#### Scenario: Bunny backend missing required config fails fast

- **WHEN** the runtime starts with `STORAGE_BACKEND=bunny` but `STORAGE_BUNNY_ACCESS_KEY` unset
- **THEN** `createStorage(config)` SHALL reject with an error naming the missing field
- **AND** the runtime SHALL NOT begin serving

#### Scenario: Unknown backend value fails fast

- **WHEN** the runtime starts with `STORAGE_BACKEND=s3`
- **THEN** `createStorage(config)` SHALL reject with an error identifying the unrecognised backend
- **AND** the runtime SHALL NOT begin serving

### Requirement: Storage layout

The **filesystem** backend's persistence root SHALL contain two kinds of entries used by different consumers:

- `events.db` — the libSQL database file (owned by EventStore + QueueStore; holds the `events` and `queue_items` tables).
- `workflows/<owner>/<repo>/<sha>.tar.gz` — workflow tarballs (owned by `workflow-registry`).

There SHALL NOT be a DuckDB file (`events.duckdb`), a Parquet directory (`events/`), a lakehouse catalog, or `pending/` / `archive/{id}.json` entries. Operators wipe any pre-existing legacy entries before deploying this change (see `docs/upgrades.md`).

This co-location requirement applies only to the filesystem backend. A remote backend (e.g. `bunny`) stores only the `workflows/` bundle tree; `events.db` then lives separately on a local volume addressed by `DATABASE_URL` (see the `runtime-config` `Database connection config fields` requirement). The bundle key shape (`workflows/...`) is identical across backends because keys are opaque.

#### Scenario: Layout under FS backend

- **GIVEN** an FS backend with root `/var/lib/wfe`
- **AND** EventStore has committed at least one terminal invocation under `(acme, foo)`
- **AND** workflow-registry has stored at least one bundle for `(acme, foo, sha1)`
- **WHEN** the layout is inspected
- **THEN** `/var/lib/wfe/events.db` SHALL exist
- **AND** `/var/lib/wfe/workflows/acme/foo/sha1.tar.gz` SHALL exist
- **AND** `/var/lib/wfe/events.duckdb`, `/var/lib/wfe/events/`, `/var/lib/wfe/pending/`, and `/var/lib/wfe/archive/` SHALL NOT exist

#### Scenario: Layout under a remote backend splits db from bundles

- **GIVEN** a runtime started with `STORAGE_BACKEND=bunny` and `DATABASE_URL=file:/data/events.db`
- **WHEN** the layout is inspected
- **THEN** `events.db` SHALL live on the local volume at `/data/events.db`
- **AND** the Bunny zone SHALL contain only the `workflows/` bundle tree (no `events.db`)

### Requirement: Backend conformance suite

The repository SHALL provide a backend-agnostic conformance test suite that exercises the `StorageBackend` contract against a supplied implementation, and SHALL run it against the filesystem backend and the Bunny backend. The suite SHALL cover: byte-level write/read roundtrip, recursive `list` over a prefix, exclusion of non-matching and `.tmp` keys from `list`, `NotFoundError` on read of a missing key, and atomic replacement on overwrite.

The Bunny backend SHALL run the suite against a mocked HTTP layer (undici `MockAgent`) that emulates the Edge Storage API surface the backend depends on: `PUT` object replace, `GET` returning bytes or `404`, and directory-listing JSON. The mock SHALL pin the boot-probe status classifications (`401`/`403` fatal, `200`/empty success) so the probe logic is covered even though the suite does not reach the live API.

#### Scenario: Filesystem backend passes the conformance suite

- **WHEN** the conformance suite is run against `createFsStorage`
- **THEN** every contract assertion SHALL pass

#### Scenario: Bunny backend passes the conformance suite against the mock

- **WHEN** the conformance suite is run against `createBunnyStorage` wired to the undici `MockAgent`
- **THEN** every contract assertion SHALL pass
- **AND** the `.tmp`-exclusion assertion SHALL hold vacuously (the Bunny backend writes no `.tmp` artifacts)
