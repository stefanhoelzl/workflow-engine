## Why

The live staging deployment runs on bunny.net Magic Containers, whose single
volume is **accept-loss** (no backups, reattachment across reschedule not
guaranteed). Today both `events.db` and the workflow bundle tree (`workflows/`)
live on that volume, so every reschedule can silently drop all uploaded
bundles until the next deploy re-uploads them. Moving bundles to a durable
Bunny Edge Storage zone removes that data-loss window for the bundle store
while leaving the low-stakes `events.db` on local disk. It also proves the
`StorageBackend` remote-backend seam end to end on a real provider before any
prod cutover.

## What Changes

- Add a **`bunny` `StorageBackend`** implementation backed by the Bunny Edge
  Storage HTTP API origin (`PUT`/`GET`/`DELETE`/directory-listing), selected by
  `STORAGE_BACKEND=bunny`. Reads/writes go to the storage origin directly (never
  a CDN pull zone) so `recover()` never observes a stale bundle.
- Register `bunny` in the `createStorage` factory. The factory owns
  backend-identity validation: it asserts the required `STORAGE_BUNNY_*` config
  is present and fails fast at boot when it is not.
- Add config fields `STORAGE_BUNNY_ENDPOINT`, `STORAGE_BUNNY_STORAGE_ZONE`
  (non-secret) and `STORAGE_BUNNY_ACCESS_KEY` (`Secret`-wrapped). All three are
  **optional at the schema level**; required-ness is enforced by the factory so
  the config layer never enumerates backends (preserving the existing
  `STORAGE_BACKEND` "factory owns the backend list" principle).
- Provision a `bunnynet_storage_zone` (region DE/Frankfurt) in tofu and wire the
  **Magic Containers staging app only** to `STORAGE_BACKEND=bunny` +
  `STORAGE_BUNNY_*`. The access key flows from the zone resource's `password`
  attribute straight into the app env as a sensitive value — no new GHA
  secret / TF_VAR. Prod stays on `fs` (Bunny is the sole staging backend; the
  VPS staging stack was retired upstream).
- Add an HTTP-mock conformance run: the existing backend-agnostic
  `conformanceSuite()` runs against a mocked Bunny HTTP layer (undici
  `MockAgent`), including the boot-probe status classification.
- Spec hygiene folded in: correct the stale `storage-backend` Purpose (drops
  `pending/`/`archive/` and the `PERSISTENCE_S3_*`-selection text) and scope the
  Storage-layout requirement to the FS backend, since the bunny deployment
  splits `events.db` (local volume) from `workflows/` (remote zone).

## Capabilities

### New Capabilities
<!-- none — the StorageBackend seam already exists; this adds an implementation behind it -->

### Modified Capabilities
- `storage-backend`: add the Bunny backend implementation requirement and its
  conformance coverage; correct the stale Purpose; scope the Storage-layout
  requirement to FS.
- `runtime-config`: add the `STORAGE_BUNNY_*` config fields (optional;
  access key `Secret`-wrapped); amend the `STORAGE_BACKEND` requirement to state
  that the factory — not the config schema — owns per-backend required-config
  validation.
- `infrastructure`: provision the `bunnynet_storage_zone` and document the
  zone/access-key flow.
- `bunny-staging`: the Magic Containers staging app sets `STORAGE_BACKEND=bunny`
  and the `STORAGE_BUNNY_*` env (access key referenced from the zone resource).

## Impact

- **Code**: new `packages/runtime/src/storage/bunny.ts`; new `case "bunny"` in
  `storage/factory.ts`; new `STORAGE_BUNNY_*` fields in `config.ts`; new
  HTTP-mock conformance test wiring `conformanceSuite()`.
- **Infra**: new `bunnynet_storage_zone` resource; `bunny-staging.tf` env
  additions; `docs/infrastructure.md` update; operator-driven `apply-infra` to
  provision the zone (agents do not run `tofu apply`).
- **Network**: new outbound egress from the runtime to the Bunny storage host
  (e.g. `storage.bunnycdn.com`); new secret (`STORAGE_BUNNY_ACCESS_KEY`).
  `SECURITY.md` note required.
- **No** changes to `WorkflowRegistry` recovery/upload call sites, the SDK
  surface, `demo.ts`, the sandbox boundary, the EventBus consumer pipeline, or
  the workflow manifest format.
- **Scope boundary**: staging only (Bunny is the sole staging backend after the
  upstream VPS-staging retirement). Prod stays on `fs`. Flipping prod later is a
  config-only change.
