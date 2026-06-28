## 1. Config schema (runtime-config)

- [x] 1.1 Add `STORAGE_BUNNY_ENDPOINT` (plain string, optional) and `STORAGE_BUNNY_STORAGE_ZONE` (plain string, optional) to the Zod schema in `packages/runtime/src/config.ts`, each with the `// biome-ignore lint/style/useNamingConvention: env var name` comment used by the other `STORAGE_*`/`PERSISTENCE_*` fields; expose as `storageBunnyEndpoint` / `storageBunnyStorageZone`.
- [x] 1.2 Add `STORAGE_BUNNY_ACCESS_KEY` as `z.exactOptional(z.string().transform(createSecret))`; expose as `storageBunnyAccessKey?: Secret`. Do NOT cross-validate against `STORAGE_BACKEND` (no `superRefine`).
- [x] 1.3 Unit tests in `config.test.ts`: fields parse; access key is `Secret` and `.reveal()` works; `JSON.stringify` redacts; all three default to `undefined`; `STORAGE_BACKEND=bunny` with no bunny fields still parses (carried through, factory validates later).

## 2. Bunny backend (storage-backend)

- [x] 2.1 Create `packages/runtime/src/storage/bunny.ts` exporting `createBunnyStorage(config)` returning a `StorageBackend`. Build the object URL as `https://<endpoint>/<zone>/<key>`; send the `AccessKey` header on every request (reveal the secret only here).
- [x] 2.2 Implement `write` (HTTP `PUT` raw bytes; non-2xx throws), `read` (`GET`; `200`→`Uint8Array`, `404`→`NotFoundError`, other non-2xx throws), and `list(prefix)` (recursive walk of directory-listing JSON; yield opaque object keys, skip directory entries). No retry anywhere.
- [x] 2.3 Implement the boot probe inside `createBunnyStorage`: one zone-root `GET`/list; `401`/`403`→throw (fatal), `200`/empty→proceed, other non-2xx→throw. No retry.
- [x] 2.4 Register `case "bunny"` in `packages/runtime/src/storage/factory.ts`; assert `storageBunnyEndpoint`, `storageBunnyStorageZone`, and `storageBunnyAccessKey` are present and throw a descriptive boot error naming any missing field; update the unknown-backend error message to mention `bunny`.

## 3. Tests (storage-backend conformance)

- [x] 3.1 Add a fake-`fetch` harness emulating the Edge Storage surface (house pattern: injected `fetchFn`, not undici MockAgent): `PUT` object replace, `GET` returning bytes or `404`, directory-listing JSON, and probe statuses (`401`/`403`/`200`/empty). (`bunny.test.ts`)
- [x] 3.2 Run the shared `conformanceSuite()` (extracted to `conformance-suite.ts`) against `createBunnyStorage` wired to the fake (alongside the fs run). `.tmp`-exclusion holds vacuously.
- [x] 3.3 Add targeted tests: `read` 404→`NotFoundError`; recursive `list` yields keys not directories; requests target the storage origin host (never a CDN host); boot probe `401`→reject, `200`/empty→ready + empty `list`; missing-field factory error.

## 4. Spec hygiene (storage-backend base spec)

- [x] 4.1 Edit `openspec/specs/storage-backend/spec.md` Purpose: drop `pending/`+`archive/` references and the "`PERSISTENCE_PATH` vs `PERSISTENCE_S3_*`" selection text; state selection is driven by `STORAGE_BACKEND` and the store is bytes-only for bundles. (Storage-layout + factory + conformance requirement edits land via the delta at archive time.)

## 5. Infrastructure (tofu)

- [x] 5.1 Add a `bunnynet_storage_zone` resource for staging in `infrastructure/bunny-staging.tf` (main region Frankfurt/DE, `Standard` tier, name `wfe-staging-bundles`).
- [x] 5.2 In `bunny-staging.tf`, add the env entries (alphabetized): `STORAGE_BACKEND=bunny`, `STORAGE_BUNNY_ACCESS_KEY` = `bunnynet_storage_zone.staging_bundles.password`, `STORAGE_BUNNY_ENDPOINT=storage.bunnycdn.com`, `STORAGE_BUNNY_STORAGE_ZONE` = the zone name. `PERSISTENCE_PATH=/data` left in place.
- [x] 5.3 No new `TF_VAR_*`/GHA secret introduced for the access key; relies on the provider-sensitive `password` attribute to keep it out of the plan summary.
- [x] 5.4 `tofu fmt -check -recursive` and `tofu -chdir=infrastructure validate` pass. (`tofu plan` needs real backend creds/state → operator/CI via `apply-infra`; see Cluster smoke H.1.)

## 6. Docs & security

- [x] 6.1 `docs/infrastructure.md`: added "Bundle storage on Bunny Edge Storage" subsection (origin-not-CDN, access-key-from-zone-attribute, scope, rollback) + "What tofu manages" bullet + durability note.
- [x] 6.2 `SECURITY.md`: added Bunny Edge Storage egress row (§5) and noted `STORAGE_BUNNY_ACCESS_KEY` (`Secret`-wrapped, revealed only at the HTTP `AccessKey` header, sourced from the zone resource — the (a)/(b) exception).
- [x] 6.3 `docs/upgrades.md`: added the 2026-06-28 entry (operator action, no tenant rebuild, rollback).

## 7. Validation

- [x] 7.1 `pnpm validate` passes (lint, check, 1551 tests incl. new config + bunny + conformance, tofu fmt/validate).
- [x] 7.2 `openspec validate bunny-bundle-storage-staging --strict` passes.

## Dev probe (agent, against `pnpm dev`)

`pnpm dev` cannot reach a real Bunny zone, so the backend is exercised via the mocked conformance run, not `pnpm dev`. Verified instead:

- [x] D.1 `pnpm test packages/runtime/src/storage` — fs + bunny conformance suites both green (69 tests in the storage+config run).
- [x] D.2 `pnpm dev --random-port --kill` (default `STORAGE_BACKEND=fs`) boots to "Runtime listening" with `storageBackend":"fs"` and serves `/livez` → 200 — the new config fields + factory `case` don't regress the default fs path. Process tree killed after.
- [x] D.3 Factory fail-fast on `STORAGE_BACKEND=bunny` with a missing `STORAGE_BUNNY_ACCESS_KEY` is asserted by the `createStorage` unit test ("fails fast naming a missing STORAGE_BUNNY_* field").

## Cluster smoke (human)

Operator-run at rollout (agents do NOT run `tofu apply`):

- [x] H.1 `tofu apply` created `bunnynet_storage_zone.staging_bundles` and rolled the staging app env (`STORAGE_BACKEND=bunny` + `STORAGE_BUNNY_*`, access key from the zone's sensitive `password`). Done 2026-06-28 (needed a detach-first targeted apply to clear the retired VPS-staging volume — Scaleway can't delete an attached volume; documented for the retire-VPS-staging runbook).
- [x] H.2 Live API sanity check passed against the real zone: valid key → `200` with `[]` (fresh zone), wrong key → `401`. Confirms the boot-probe status classification against the real Bunny wire format.
- [ ] H.3 Trigger a `deploy-staging`; after the rotation, confirm the staging app booted (`/livez` 200, `/readyz` pass) and that `wfe upload` re-populated bundles into the zone (`curl -H "AccessKey: <key>" https://storage.bunnycdn.com/wfe-staging-bundles/workflows/` lists the uploaded owners/repos).
- [ ] H.4 Reschedule/restart the staging container and confirm bundles survive (dashboard drill-down still resolves workflows without a fresh upload) — the durability win.
