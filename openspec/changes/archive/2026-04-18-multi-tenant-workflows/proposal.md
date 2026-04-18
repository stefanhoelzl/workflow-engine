## Why

The workflow engine today has a single, flat workflow namespace: every authenticated user sees every workflow and every invocation. The `GITHUB_USER` allow-list gates who can use the system at all but says nothing about who owns what. This blocks any scenario where multiple people or teams want to deploy workflows into the same instance without trampling each other's work or viewing each other's invocation history. Introducing a tenant boundary — owned by a GitHub org, or by an individual user as a pseudo-org — is the smallest model that lets multiple independent actors coexist on one deployment while reusing the identity signal (`user.orgs`, `user.name`) that both auth paths already resolve.

## What Changes

- **BREAKING** Workflow upload endpoint becomes `POST /api/workflows/<tenant>`; the body is a tarball containing the tenant's **entire** workflow set (atomic, all-or-nothing replacement). Per-workflow uploads are removed.
- **BREAKING** Tarball format changes: a single root `manifest.json` (new schema listing all workflows, their actions, and triggers) plus one `<name>.js` per workflow at the tarball root. The pre-existing per-workflow `manifest.json` + directory layout is removed.
- **BREAKING** Webhook URL shape changes to `/webhooks/<tenant>/<workflow-name>/<trigger-path>`; trigger registry is keyed by `(tenant, name, path)`.
- **BREAKING** `InvocationEvent` schema gains a required `tenant` field; event-store index gains a `tenant` column. Existing `pending/` + `archive/` events must be wiped on upgrade.
- **BREAKING** Bundle storage layout becomes `workflows/<tenant>.tar.gz` on the storage backend. `WORKFLOWS_DIR` bootstrap is removed; the runtime boots from the storage backend only.
- **BREAKING** `wfe upload` CLI tars the whole build output into one per-tenant bundle and POSTs once; the multi-POST loop is removed. Users must pass a `--tenant` (or configure it).
- Workflow registry is keyed by `(tenant, name)`; name collisions across tenants are now legal and expected.
- `/api/workflows/<tenant>` requires the caller to be a member of `<tenant>` (in `user.orgs` or equal to `user.name`); the existing `GITHUB_USER` allow-list still gates access to the engine.
- Dashboard and Trigger UIs gain an **active tenant selector** at the top; page content is scoped to the selected tenant's invocations/triggers via a server-side filter.
- Live re-upload uses **refcounted runners**: in-flight invocations keep their old sandbox; new invocations bind to the latest; old sandboxes dispose when refcount reaches zero. (Across restarts there is no pin — `recovery.ts` already terminates pre-crash invocations with a synthetic `trigger.error`.)
- Webhooks remain public (SECURITY.md §3 invariant preserved); tenant prefix is just disambiguation, not authentication.

## Capabilities

### New Capabilities
- `tenant-model`: canonical definition of a tenant in this system — the charset regex (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`), the invariant that user-logins and real-org names never collide, the membership predicate (`user.orgs.includes(t) || user.name === t`), and the list of surfaces that enforce validation. Single reference point other specs can link to.

### Modified Capabilities
- `workflow-manifest`: new root-level (per-tenant) manifest schema listing all workflows with their actions, triggers, and module filenames.
- `workflow-loading`: boots from the storage backend (`workflows/<tenant>.tar.gz`), not from `WORKFLOWS_DIR`.
- `workflow-registry`: registry keyed by `(tenant, name)`; supports refcounted runners for in-memory hot-swap on re-upload.
- `action-upload`: endpoint is `POST /api/workflows/<tenant>`; atomic all-or-nothing replacement of the tenant's bundle; membership check.
- `http-trigger`: webhook URL shape `/webhooks/<tenant>/<workflow-name>/<trigger-path>`; trigger registry keyed by `(tenant, name, path)`.
- `invocations`: `InvocationEvent` gains a required `tenant` field, stamped by the runner at emit time.
- `event-store`: DuckDB index gains a `tenant` column; query surface supports `WHERE tenant = ?`.
- `github-auth`: `/api/workflows/<tenant>` enforces tenant membership in addition to `GITHUB_USER` allow-list.
- `dashboard-list-view`: active tenant selector; server-side filter on selected tenant.
- `trigger-ui`: active tenant selector; filter triggers by selected tenant.
- `cli`: `wfe upload` produces a single per-tenant tarball and POSTs once, targeting the tenant-scoped route.
- `runtime-config`: `WORKFLOWS_DIR` removed; `workflowsBucket`-style storage configuration is the sole bootstrap source.

## Impact

- **Breaking rollout.** `pending/`, `archive/`, and any bundle storage must be wiped on upgrade (document in `CLAUDE.md` alongside the monotonic-timestamps note). All users must re-upload via the new `wfe upload` flow.
- **SECURITY.md §4** gains a new invariant: every `/api/workflows/<tenant>` path parameter must be validated against the tenant regex and membership-checked before the handler runs.
- **SECURITY.md §3** is unchanged in spirit but explicit about the new URL shape: `/webhooks/<tenant>/<name>/<path>` stays public; tenant prefix is identification, not authorization.
- **Auth middleware wiring**: `/api/*` routes must run `userMiddleware` (already resolves `user.orgs` for both oauth2-proxy and Bearer-token paths) in addition to `githubAuthMiddleware`.
- **`wfe` CLI** (`packages/sdk/src/cli/upload.ts`) is rewritten to tar the whole build directory and POST once.
- **`vite-plugin`** output aggregates all workflow manifests into one root manifest during the final pack step.
- **Dev workflow**: `pnpm local:up` no longer auto-seeds from `WORKFLOWS_DIR`; developers upload via `wfe upload` (document in `CLAUDE.md`).
- **Tests**: integration tests that rely on `WORKFLOWS_DIR` bootstrap must switch to upload-via-API fixtures.
