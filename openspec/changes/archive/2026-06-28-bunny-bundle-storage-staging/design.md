## Context

The live staging deployment runs on bunny.net Magic Containers (`bunny-staging.tf`).
Its single `/data` volume is **accept-loss** — no backups, reattachment across
reschedule not guaranteed — yet it holds both `events.db` and the workflow bundle
tree (`workflows/<owner>/<repo>.tar.gz`). A reschedule can therefore drop every
uploaded bundle until the next deploy re-uploads.

The `StorageBackend` seam already exists and is hardened for remote backends:
`write/read/list` + `NotFoundError`, an opaque-key contract, a `createStorage`
factory keyed on `STORAGE_BACKEND` (only `"fs"` registered today), and a
backend-agnostic `conformanceSuite()`. `DATABASE_URL` already decoupled the
libSQL DB location from `PERSISTENCE_PATH`. So bundle storage and DB storage are
already independent axes — this change moves only the bundle axis to a durable
remote store on staging.

This is also the first real exercise of the remote-backend seam against a live
provider, ahead of any prod cutover.

## Goals / Non-Goals

**Goals:**
- A `bunny` `StorageBackend` over the Bunny Edge Storage HTTP origin, drop-in
  behind `createStorage` with zero `WorkflowRegistry` call-site changes.
- Durable staging bundles surviving Magic Containers reschedule.
- Fail-fast boot on bad credentials / wrong zone; deterministic mock-based tests.
- Keep the config layer free of backend enumeration (factory owns it).

**Non-Goals:**
- Prod migration (stays `fs`). (The VPS staging stack was retired upstream —
  Bunny is the sole staging backend — so there is no second staging deployment
  to consider.)
- Migrating existing staging bundles (CI re-uploads on every deploy).
- Moving `events.db` off the local volume (separate `DATABASE_URL` axis).
- Retry/backoff, CDN read acceleration, multi-region replication, object
  deletion/GC of stale bundles.
- A live integration test in CI.

## Decisions

### D1 — Storage origin, never a CDN pull zone
Read/write go to `https://<endpoint>/<zone>/<key>` with the `AccessKey` header.
A CDN pull zone caches GETs; after a bundle re-upload, `recover()` could read a
stale object — a correctness bug. Origin reads are always fresh. *Alternative
(CDN reads for edge speed) rejected*: staging bundle reads happen at boot, not on
the hot path, so there is no speed argument worth a staleness risk.

### D2 — Factory owns per-backend required-config validation; config stays dumb
`STORAGE_BUNNY_*` are **optional** schema fields (access key `Secret`-wrapped).
`createBunnyStorage` asserts presence and throws at boot when any is missing.
This preserves the existing `STORAGE_BACKEND` principle ("the config layer and
the factory SHALL NOT each own a partial backend list"). *Alternative
(conditional `superRefine` in config keyed on `STORAGE_BACKEND === "bunny"`)
rejected*: it reintroduces backend knowledge into config and grows a config
branch per future backend. Secret-wrapping stays a config concern regardless;
only required-ness moves to the factory. Fail-fast is preserved because the
factory runs at boot.

### D3 — Status-keyed boot probe
A single zone-root `GET`/list at construction, classified by status: `401/403`
→ fatal (bad key), `200`/empty → success (a fresh empty zone is healthy),
anything else → fatal. This distinguishes "bad creds" from "empty zone" so the
first deploy against an empty zone boots cleanly. The mock pins these
classifications so the logic is tested.

### D4 — No retry
Single attempt on every operation; `404` → `NotFoundError` (no retry). At boot,
`recover()` or the probe crashing on a transient blip is acceptable — Magic
Containers restarts the container. Keeps the backend small; retry can be added
later behind the same interface if needed.

### D5 — Access key from the zone resource attribute
Tofu provisions `bunnynet_storage_zone` and wires its `password` attribute
straight into the staging app env (provider-marked sensitive). No new
`TF_VAR_*`/GHA secret — tofu owns the whole loop, and the value stays out of the
`plan-infra` summary. *Alternative (separate `TF_VAR` from a GHA secret)
rejected*: more moving parts for a value tofu already produces.

### D6 — Keys at zone root, opaque
Bundles written as `workflows/<owner>/<repo>.tar.gz` at the zone root; no key
prefix. The zone is dedicated to staging. Keys stay opaque, so the spec's
internal `<repo>.tar.gz` vs `<repo>/<sha>.tar.gz` ambiguity does not touch the
backend.

### D7 — Mock-based conformance, plus spec hygiene
The existing `conformanceSuite()` runs against `createBunnyStorage` wired to an
undici `MockAgent` emulating PUT/GET/404/directory-listing. `.tmp` exclusion
holds vacuously (no staging artifacts). While here, fix the stale
`storage-backend` Purpose (drops `pending/`/`archive/` + `PERSISTENCE_S3`
selection text) and scope the Storage-layout requirement to FS.

### Bundle read/write flow

```
  wfe upload ──PUT /{zone}/workflows/o/r.tar.gz (AccessKey)──▶ Bunny Edge Storage
                                                                     │
  boot ─▶ createBunnyStorage ─probe GET /{zone}/ ─▶ 200[] ok | 401 crash
            │
            ▼
  WorkflowRegistry.recover() ─list("workflows/")─▶ recurse dir JSON ─▶ keys
            │                                                            │
            └──────────── read("workflows/o/r.tar.gz") ◀────────────────┘
                            GET → bytes | 404 → NotFoundError (log+skip)
```

## Risks / Trade-offs

- **[Mock-only tests never see the real wire format]** → Probe is status-keyed so
  the classification logic is unit-tested; a one-time live sanity check (real key
  → `200 []` on fresh zone, bad key → `401`) is listed in the `## Cluster smoke
  (human)` block at rollout. First true validation is at operator apply.
- **[No retry → boot crash on a transient Bunny blip]** → Accepted; Magic
  Containers restarts. Bounded retry can be added later behind the interface.
- **[New outbound egress + new secret]** → Runtime now calls the Bunny storage
  host and reads `STORAGE_BUNNY_ACCESS_KEY`. Note in `SECURITY.md` (egress +
  secret handling; key is `Secret`-wrapped and revealed only at the HTTP header).
- **[Bunny volume still accept-loss for `events.db`]** → Out of scope; `events.db`
  is low-stakes and the remote-DB cutover is a separate change.

## Migration Plan

1. Land code + tofu (zone resource + staging env) + tests behind this change.
2. Operator runs `apply-infra` to provision the zone and roll the staging app
   env (agents do not run `tofu apply`); PR summary flags the apply.
3. First `deploy-staging` after apply re-runs `wfe upload` against the staging
   host → populates the zone. Empty zone before that is healthy.
4. Live sanity check per the smoke block.
5. **Rollback**: set `STORAGE_BACKEND` back to `fs` (or unset) on the staging app
   and re-deploy; bundles fall back to the local volume on next upload. The zone
   can be left in place (idle) or destroyed.

## Open Questions

- None blocking. The exact Edge Storage region→host mapping is captured by
  setting `STORAGE_BUNNY_ENDPOINT` explicitly (no mapping table to maintain).
