## Why

The DuckDB→libSQL swap (archived `2026-06-26-replace-duckdb-with-libsql`) deliberately deferred everything about pointing the runtime at a **remote** libSQL service (Bunny Database): the `DATABASE_URL`/auth-token config, the remote single-writer treatment, and the infra wiring. The `event-store` spec already names this follow-up ("Pointing the store at a remote libSQL service … is out of scope here and treated by the separate remote-backend change"). This change lands that **preparation** so a future cutover to Bunny is a pure env-var flip — it does **not** switch any environment to a remote database.

## What Changes

- Introduce a **single, required** `DATABASE_URL` env var (no `PERSISTENCE_PATH` derivation) that carries the libSQL connection — `file:…` for embedded, `libsql://…`/`https://…` for remote. **BREAKING (operator)**: every environment must now set `DATABASE_URL` explicitly or the runtime fails to boot.
- Add `DATABASE_WAL` (string→bool, default `false`) — gates the embedded-only `PRAGMA journal_mode=WAL`. Add `DATABASE_AUTH_TOKEN` (sealed secret via `.transform(createSecret)`, remote-only).
- A `superRefine` fails closed at boot only when `DATABASE_AUTH_TOKEN` is set **and** `DATABASE_WAL=true` (a contradictory embedded+remote intent). No scheme↔variant cross-validation (kept minimal).
- Refactor `main.ts` to build the `@libsql/client` from `DATABASE_URL` via a discriminated options union `{ authToken } | { wal }` — auth-token present selects the remote variant (no pragma, no `mkdir`); absent selects embedded (runs WAL pragma iff `wal`). The single shared client still feeds both Kysely stores, unchanged.
- Edit **all embedded boot paths now**, staying on `file:`: `bunny-staging.tf`, the VPS prod `apps.tf`, the `pnpm dev` bootstrap, and the test/e2e harness — each sets `DATABASE_URL=file:${PERSISTENCE_PATH}/events.db` + `DATABASE_WAL=true`. No Bunny Database resource is provisioned.
- Rewrite the `event-store` single-writer requirement to cover the remote case: remote libSQL has **no file-level exclusion at all** (weaker than embedded's assumed-present file). Treat single-writer as a document-only deployment contract resting on `autoscaling_min=max=1` + sequential rollout; note an app-level lease as a future option, do not build it.
- Document the cutover/flip runbook (how to point at Bunny later) and a pre-prod verification checklist (cold-start latency, token rotation, TLS/region, Hrana negotiation) for the public-preview service.

**Explicitly out of scope (deferred again):** remote cold-start read-path retry/timeouts, an app-level single-writer lease/fence, exact-pinning the libSQL deps (caret ranges kept), and the actual Bunny Database provisioning/cutover. No SDK or sandbox-stdlib surface change (so `demo.ts` is untouched); event/queue schema and the commit-retry loop are unchanged.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `runtime-config`: ADD `DATABASE_URL` (required), `DATABASE_WAL` (default `false`), `DATABASE_AUTH_TOKEN` (sealed secret); ADD the `authToken`+`WAL=true` contradiction refinement.
- `event-store`: the caller now builds the `Kysely` db from `DATABASE_URL` (was "e.g. `file:<PERSISTENCE_PATH>/events.db`"); rewrite the single-writer requirement to address remote libSQL (no lock at all) as a document-only contract.
- `persistence`: the substrate is "a libSQL database, embedded file **or** remote service" (was "a single embedded database file").
- `bunny-staging`: staging container declares `DATABASE_URL`/`DATABASE_WAL` env (embedded `file:` values; stays embedded).
- `infrastructure`: the VPS prod app declares the same `DATABASE_URL`/`DATABASE_WAL` embedded env.
- `e2e-test-framework`: the harness sets `DATABASE_URL` + `DATABASE_WAL=true` for the runtime under test and its second read connection.

## Impact

- **Config/wiring:** `packages/runtime/src/config.ts` (3 new env vars + refinement), `packages/runtime/src/main.ts` (client builder union, drop `mkdir`/`dbRoot`).
- **Tests:** `packages/runtime/src/test-utils/libsql.ts` and the e2e harness must supply `DATABASE_URL`/`DATABASE_WAL`; `config` and `event-store` tests gain coverage for the new vars + refinement.
- **Infra:** `infrastructure/bunny-staging.tf`, `infrastructure/apps.tf` (env blocks). No new Bunny resource; `plan-infra` must stay empty after apply.
- **Docs:** `docs/upgrades.md` (BREAKING operator entry — required `DATABASE_URL`), `docs/infrastructure.md` (the flip runbook + pre-prod checklist).
- **Dependencies:** none added; `@libsql/client`/`@libsql/kysely-libsql` caret ranges unchanged.
- **Security:** `DATABASE_AUTH_TOKEN` is auth material — flows through `.transform(createSecret)` and is never logged (SECURITY.md §4/§5). No sandbox-boundary or EventBus-consumer-pipeline change; no manifest format change.
