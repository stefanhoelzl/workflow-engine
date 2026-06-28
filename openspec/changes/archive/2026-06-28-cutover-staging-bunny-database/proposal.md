## Why

The remote-libSQL seam (`DATABASE_URL` / `DATABASE_AUTH_TOKEN`, archived `prepare-remote-libsql`) was built so that pointing an environment at a managed libSQL service is "a pure connection-config flip." Bunny Database (managed libSQL) is now in public preview, and the seam's intended target. This change performs that flip for **staging only**: staging's event-store and per-workflow queues move off the embedded on-disk `file:/data/events.db` and onto a managed Bunny Database. Prod is untouched and stays on the VPS embedded.

## What Changes

- Provision a `bunnynet_database` resource for staging (`regions_primary = ["DE"]`, no replicas) and consume its `url` output as the staging container's `DATABASE_URL`.
- Mint the Bunny Database access token **inside `tofu apply`** via a `magodo/restful` `restful_operation` resource (`PUT …/auth/generate`, `authorization = "full-access"`), authenticated with the existing account API key (`var.bunnynet_api_key`). The token is captured as a `sensitive` output and wired into a new `DATABASE_AUTH_TOKEN` env entry. This mirrors how `SECRETS_PRIVATE_KEYS` is already generated into tofu state.
- **BREAKING (operator):** the staging container env now sets `DATABASE_AUTH_TOKEN` and **removes** `DATABASE_WAL` (the config `superRefine` fails closed at boot when a token is present and `DATABASE_WAL=true`). `DATABASE_URL` changes from `file:/data/events.db` to the remote `libsql://…` URL.
- **Remove the `/data` volume + volumemount — staging becomes fully stateless.** On current main, workflow bundles already live on a Bunny Edge Storage zone (`STORAGE_BACKEND=bunny`); with `events.db` now on the Bunny Database, nothing is written to local disk. `PERSISTENCE_PATH=/data` stays set (config-required) but is never touched at runtime.
- Add the apply + rollback runbook and the token/cold-start/limits caveats to `docs/infrastructure.md`. Add `magodo/restful` to `required_providers` and refresh `.terraform.lock.hcl`.

Explicitly **not** in scope (deferred, as before): remote cold-start read-path retry/timeouts (D7), an app-level single-writer lease (D6), any prod cutover, and any runtime/SDK code change. No EventBus-consumer, manifest, or sandbox-boundary change.

## Capabilities

### New Capabilities
<!-- none — this is an infra config flip on an existing capability -->

### Modified Capabilities
- `bunny-staging`: the staging container env flips to remote libSQL (`DATABASE_URL` from the provisioned database, `DATABASE_AUTH_TOKEN` set, `DATABASE_WAL` removed); a Bunny Database resource and an in-tofu token-mint are now REQUIRED where the prior spec said a remote libSQL resource SHALL NOT be declared and `DATABASE_AUTH_TOKEN` SHALL NOT be set; the "Staging persistent volume mounted at /data" requirement is REMOVED (staging is now fully stateless — DB on Bunny Database, bundles already on Bunny Edge Storage); the secrets-env requirement adds `DATABASE_AUTH_TOKEN`.

## Impact

- **Infra:** `infrastructure/bunny-staging.tf` (new `bunnynet_database` + `restful_operation`, env flip, `/data` volume + volumemount removed), `infrastructure/main.tf` (`magodo/restful` provider), `infrastructure/.terraform.lock.hcl` (multi-platform hashes), `infrastructure/variables.tf` (none new — token is minted, not supplied; API key already exists).
- **Docs:** `docs/infrastructure.md` (apply/rollback runbook + caveats).
- **Runtime code:** none. The `runtime-config` seam already accepts a remote URL + token; `demo.ts` untouched.
- **Pre-merge gate:** `plan-infra` shows a non-empty plan (new resources) — operator runs `apply-infra`; agents surface the apply need in the PR summary.
- **Operational caveats:** Bunny Database preview limits (1 GB/DB, no automatic backups — accept-loss, consistent with the existing staging posture); `…/auth/revoke` invalidates ALL tokens for that database; staging's existing embedded event history is dropped on cutover (accept-loss).
