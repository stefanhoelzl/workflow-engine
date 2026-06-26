## 1. Config seam (`packages/runtime/src/config.ts`)

- [x] 1.1 Add `DATABASE_URL` (required `z.string()`), `DATABASE_WAL` (string→bool via `z.stringbool`, default `false`), and `DATABASE_AUTH_TOKEN` (`z.exactOptional(z.string().transform(createSecret))`) to the schema; surface them on the transformed config as `databaseUrl`, `databaseWal`, `databaseAuthToken`.
- [x] 1.2 Add a `superRefine` that fails closed only when `databaseAuthToken` is set AND `databaseWal === true`. Do NOT add scheme↔variant cross-validation.
- [x] 1.3 Keep `PERSISTENCE_PATH` required (still roots tenant bundles); remove any DB-path derivation from it.
- [x] 1.4 Unit tests in `config.test.ts`: embedded-with-WAL parse, missing-`DATABASE_URL` throws, `"false"` parses to `false` (regression vs `z.coerce.boolean`), auth-token is `Secret` + redacts + `reveal()`, contradictory remote+WAL throws, remote-without-token parses OK.

## 2. Client builder (`packages/runtime/src/main.ts`)

- [x] 2.1 Replace the `dbRoot`/`mkdir`/`file:${PERSISTENCE_PATH}/events.db` block with a `buildSqlClient(url, opts)` helper taking the union `{ authToken: string } | { wal: boolean }`.
- [x] 2.2 Select the variant from `config.databaseAuthToken` presence: present → `{ authToken: databaseAuthToken.reveal() }` (remote: `createClient({ url, authToken })`, no pragma); absent → `{ wal: config.databaseWal }` (embedded: `createClient({ url })`, run `PRAGMA journal_mode=WAL` iff `wal`).
- [x] 2.3 Drop the `mkdir(dbRoot)` (assume the DB directory exists); keep the single shared client feeding both `eventDb` and `queueDb` Kysely instances unchanged.

## 3. Embedded boot paths (required-`DATABASE_URL` fallout)

- [x] 3.1 `pnpm dev` bootstrap: set `DATABASE_URL=file:${PERSISTENCE_PATH}/events.db` + `DATABASE_WAL=true`.
- [x] 3.2 Test/e2e harness (`packages/runtime/src/test-utils/libsql.ts` and the e2e spawn default env): set `DATABASE_URL` (the temp `file:` path) + `DATABASE_WAL=true`; the harness's second read connection relies on WAL.
- [x] 3.3 `infrastructure/bunny-staging.tf`: add `DATABASE_URL=file:/data/events.db` + `DATABASE_WAL=true` env blocks (keep alphabetized); do NOT add `DATABASE_AUTH_TOKEN`; no Bunny Database resource.
- [x] 3.4 `infrastructure/apps.tf` (VPS prod + VPS staging): add `DATABASE_URL=file:/data/events.db` + `DATABASE_WAL=true` as Quadlet `Environment=` directives (non-secret).

## 4. Docs

- [x] 4.1 `docs/upgrades.md`: dated BREAKING (operator) entry — `DATABASE_URL` is now required; `DATABASE_WAL`/`DATABASE_AUTH_TOKEN` added; embedded boot paths set `file:`+WAL; no data migration.
- [x] 4.2 `docs/infrastructure.md`: the future flip runbook (set `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`, omit `DATABASE_WAL`; auth token goes in the secret env file; staging first; rollback = revert env to `file:`) + pre-prod checklist (cold-start latency, token rotation, TLS/region, Hrana negotiation) + the `libsql://`-without-token footgun caveat + the transport trade-off (WS vs HTTP by URL scheme).

## 5. Validation

- [x] 5.1 `pnpm validate` (lint + check + test + `tofu fmt -check -recursive` + `tofu validate`) passes.
- [x] 5.2 `pnpm test:e2e` passes locally (changes touch runtime spawn env + persistence layout + the harness read connection).
- [x] 5.3 `openspec validate prepare-remote-libsql --strict` passes.

## 6. Dev verification (probes against `pnpm dev`)

- [x] 6.1 Boot `pnpm dev --random-port --kill`; confirm `[READY]` marker; confirm the runtime boots with the dev-supplied `DATABASE_URL` and creates `${PERSISTENCE_PATH}/events.db`.
- [x] 6.2 Negative check: boot the runtime with `DATABASE_URL` unset → it fails fast at config parse (no silent fallback).
- [x] 6.3 Negative check: boot with `DATABASE_AUTH_TOKEN` set AND `DATABASE_WAL=true` → config parse error (the contradiction guard fires).
- [x] 6.4 Confirm `.persistence/` contains `events.db` (and WAL sidecar) and that a dashboard read path renders, i.e. the shared client + both Kysely stores still work post-refactor.

## Cluster smoke (human)

- [x] H.1 `tofu -chdir=infrastructure plan` shows ONLY the added `DATABASE_URL`/`DATABASE_WAL` env on the staging Magic Container and the VPS apps — no resource replacement, no Bunny Database resource. (Agents do NOT run `tofu apply`; surface the apply need in the PR summary.)
- [x] H.2 After the operator runs `apply-infra`, confirm staging + prod still boot embedded (`/readyz` green) with the new env, and `plan-infra` is empty.
