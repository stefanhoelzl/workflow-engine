## Context

The archived `prepare-remote-libsql` change landed the connection seam (`DATABASE_URL` required, `DATABASE_WAL` embedded-only, `DATABASE_AUTH_TOKEN` sealed/optional) and a discriminated client builder: **token present ⇒ remote variant** (`createClient({ url, authToken })`, no pragma); **absent ⇒ embedded variant** (`createClient({ url })` + optional `PRAGMA journal_mode=WAL`). A Zod `superRefine` fails closed when a token is set together with `DATABASE_WAL=true`. The seam is wired-ready everywhere; staging just stays on `file:/data/events.db`.

Bunny Database (managed libSQL) is now in public preview — the seam's intended target. The `BunnyWay/bunnynet` provider (pinned `~> 0.15`, currently `0.15.1`) exposes a `bunnynet_database` resource (since `0.12.0`) with inputs `name` / `regions_primary` / `regions_replica` and outputs only `id` + `url`. Crucially it does **not** model the access token — by design, because a Bunny Database token is shown-once, non-idempotent to create, and has no read-back endpoint, so it cannot fit Terraform's read-and-reconcile model. The token is minted via an authenticated `PUT https://api.bunny.net/database/v2/databases/{db_id}/auth/generate` (`AccessKey` = the same account API key the provider uses), returning `{ token, expires_at }`.

This change flips **staging only**. Prod stays on the VPS embedded. No runtime/SDK code changes — the seam already does everything.

## Goals / Non-Goals

**Goals:**
- Staging's event-store and per-workflow queues run on a managed Bunny Database via the existing seam.
- One `tofu apply` brings up the whole staging stack — database, token, and the env flip — with no manual token step.
- The token's provenance mirrors the existing `random_bytes.staging_secrets_key` pattern (Terraform-generated auth material living in state, injected as a plaintext platform env).
- A documented rollback to embedded `file:` (via `git revert`, which restores the volume + embedded URL; or a hot env-only rollback to an ephemeral path).

**Non-Goals:**
- Remote cold-start read-path retry/timeouts (D7) — accepted for staging, observed first.
- An app-level single-writer lease/fence (D6) — staging is a single 1/1 replica.
- Any prod cutover, or prod token wiring.
- Any runtime, SDK, or `demo.ts` change; any EventBus-consumer / manifest / sandbox-boundary change.
- Backups/replication for the Bunny Database (preview has none; accept-loss, as today).

## Decisions

### D1 — Managed Bunny Database, not self-hosted sqld
Use the managed service the seam was built for. **Why:** lowest ops; Bunny owns the host; the app receives a `url` + `authToken` exactly as the remote client variant expects. **Rejected:** a self-hosted `tursodatabase/libsql-server` sidecar in the same Magic Containers pod (reachable via `localhost`) — more control but we own JWT keys, backups, and a second container; no benefit for staging.

### D2 — Provision `bunnynet_database`; wire `DATABASE_URL` from its `url` output
Declare `bunnynet_database.staging` (`regions_primary = ["DE"]` to match the Frankfurt-pinned container; no `regions_replica`). Set the container's `DATABASE_URL = bunnynet_database.staging.url`. **Why:** single source of truth, DB lifecycle managed by tofu. **Rejected:** hardcoding the literal `libsql://…` URL — DB unmanaged, URL drifts.

### D3 — Mint the token in-tofu with `magodo/restful` `restful_operation`
Add the `magodo/restful` provider; use a `restful_operation` resource (the action primitive — no drift-reconcile) that on create issues `PUT …/v2/databases/{id}/auth/generate` with body `{ authorization = "full-access", expires_at = null }`, header `AccessKey = var.bunnynet_api_key`, and captures `token` from the response into a **sensitive** output wired to the `DATABASE_AUTH_TOKEN` env. The resource is keyed on `bunnynet_database.staging.id` so it fires exactly once per database, and calls `POST …/auth/revoke` on destroy.

**Why `restful_operation` not `restful_resource`:** the generate call has no GET/read-back; `restful_operation` performs a one-shot action and does not attempt drift detection, so a refresh/plan never re-mints. **Why in-tofu at all:** the repo already generates the staging sealing key (`random_bytes.staging_secrets_key`) into state and favors a "fully self-describing deployment" that minimizes external GHA secrets — minting the token the same way is the consistent fit, and gives the operator a single `apply`. **Rejected:** (a) operator mints once by hand + stores a new GHA secret — extra hand step and a new external secret, less consistent with the repo; (b) a `restful_resource` or `http`/`external` data source — data sources re-run every plan and `restful_resource` reconciles via read, both of which re-mint the non-idempotent token and pile up orphan JWTs; (c) scripting the `bunny` CLI via `local-exec` — couples apply to the CLI being installed/authed and can't capture the token into an attribute cleanly.

### D4 — Remove `DATABASE_WAL`, add `DATABASE_AUTH_TOKEN`
Drop the `DATABASE_WAL` env entry entirely (it defaults to `false`). **Why:** with a token present, `DATABASE_WAL=true` trips the boot `superRefine`; WAL is an embedded-only pragma and meaningless against a remote service. Add `DATABASE_AUTH_TOKEN` (alphabetized before `DATABASE_URL` per the env-ordering rule). The `bunnynet` provider does not mark `env.value` sensitive, so the token's source attribute (the `restful_operation` output) MUST be `sensitive` to keep it out of the `plan-infra` step summary.

### D5 — Remove the `/data` volume; staging goes fully stateless
On current `main`, workflow bundles already live on a Bunny Edge Storage zone (`STORAGE_BACKEND=bunny`); `events.db` was the only remaining local-disk user. With it on the Bunny Database, the `/data` volume holds nothing, so the `volume {}` + `volumemount {}` are removed and the staging container runs fully stateless. `PERSISTENCE_PATH=/data` stays set (the config field is required) but is never touched at runtime — a code trace confirmed that under `STORAGE_BACKEND=bunny` + a remote `DATABASE_URL`, `createFsStorage` is not constructed and the libSQL client is HTTP-only (no `mkdir`, no file I/O on `persistencePath`). **Why:** removes the last accept-loss local store and the only stateful surface on the Magic Container. **Alternative rejected:** keep the now-empty volume (smaller diff, but a vestigial accept-loss volume nothing writes to).

### D6 — Pre-flight, then human-applied smoke
The one genuine unknown is the exact `url` scheme Bunny returns (`libsql://` vs `https://`) and that `@libsql/client` negotiates transport cleanly. The operator runs `tofu apply` locally to stand up the live stack; an agent then runs a smoke test (trigger the demo workflow via the staging URL, confirm events read/write, check the Bunny dashboard's read/write counters), and verifies the env-revert rollback.

## Risks / Trade-offs

- **Token in tofu state** → accepted: consistent with `random_bytes.staging_secrets_key` already in state; state is encrypted at rest (`encryption {}` block) and on Scaleway Object Storage. The `restful_operation` output is marked `sensitive` so it never reaches the `plan-infra` summary.
- **`…/auth/revoke` invalidates ALL tokens for that database** → staging's Bunny Database is single-consumer, so destroy-time revoke is clean; documented as a future hazard if any other consumer ever shares the staging DB.
- **Non-idempotent mint** → keying the `restful_operation` on `bunnynet_database.staging.id` (and using the no-reconcile action primitive) ensures it fires once; a DB replacement correctly re-mints for the new id.
- **Cold-start latency / transient first read after idle** (preview spins down when idle) → accepted for staging; the existing EventStore commit-retry/backoff absorbs writes; D7 read-retry deferred and tracked.
- **Preview limits: 1 GB/DB, no automatic backups** → accept-loss, identical to the current staging volume posture.
- **Existing staging event history dropped on cutover** (fresh remote DB) → accept-loss, expected; CI re-uploads demo bundles on every boot.
- **Unknown `url` scheme / Hrana negotiation** → mitigated by the local apply + smoke before relying on staging.
- **New provider dependency (`magodo/restful`)** → adds `required_providers` + multi-platform lock entries; one-time cost, pinned per repo convention.

## Migration Plan

1. Land the change (infra + docs + spec delta). `plan-infra` will show a **non-empty** plan (new `bunnynet_database` + `restful_operation`, env diff, `/data` volume + volumemount removed) — agents surface the apply need in the PR summary; agents do NOT run `tofu apply`.
2. Operator runs `apply-infra` (or a local `tofu apply`): creates the Bunny Database, mints the token, and rolls the staging container env (`DATABASE_URL` → remote, `DATABASE_AUTH_TOKEN` set, `DATABASE_WAL` removed). Because the container image is digest-pinned out-of-band, the env change rolls forward on the next deploy/rollout.
3. Smoke (human-applied + agent-run): confirm `@libsql/client` connects, the demo workflow's events read/write against the remote DB, and the Bunny dashboard shows read/write activity.
4. **Rollback:** `git revert` the change — that restores the `/data` volume + volumemount and `DATABASE_URL=file:/data/events.db` + `DATABASE_WAL=true`, and drops `DATABASE_AUTH_TOKEN`. For a hot env-only rollback without re-adding a volume, point `DATABASE_URL` at an ephemeral path (`file:/tmp/events.db`) and drop the token (and optionally destroy the `bunnynet_database` + `restful_operation`). Accept-loss either way; remote data is independent.

## Open Questions

None blocking. Tracked for a later change (unchanged from the seam's deferral): remote cold-start read-path retry/timeouts (D7), an app-level single-writer lease (D6), and the eventual prod cutover. The exact `url` scheme is resolved empirically by the step-3 smoke.
