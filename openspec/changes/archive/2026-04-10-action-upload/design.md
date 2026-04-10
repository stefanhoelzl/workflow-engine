## Context

Workflows are currently compiled at build time by the vite-plugin into per-workflow directories (`manifest.json` + `*.js` action files), baked into the container image, and loaded from `WORKFLOW_DIR` at startup. The runtime has no mechanism to accept new workflows after initialization.

The system uses Caddy as a reverse proxy with oauth2-proxy for GitHub-based browser authentication on UI routes (`/dashboard/*`, `/trigger/*`). Webhook routes (`/webhooks/*`) are unauthenticated. There is no API authentication at the runtime level.

The storage backend (FS or S3) currently stores only event data under `pending/` and `archive/` prefixes. It is optional — without it, events exist only in memory.

## Goals / Non-Goals

**Goals:**
- Enable uploading workflow bundles via HTTP without rebuilding or restarting the runtime
- Authenticate uploads using GitHub tokens (PATs or `GITHUB_TOKEN` from CI)
- Persist uploaded workflows in the storage backend for durability across restarts
- Hot-reload uploaded workflows into the running scheduler with zero downtime
- Keep the same storage backend optional semantics: no backend configured means in-memory only

**Non-Goals:**
- Workflow deletion endpoint
- Workflow listing endpoint
- Multiple user authorization or org-based access control
- Token caching or rate limiting
- Workflow versioning or rollback
- Build-time workflow loading (upload-only mode replaces `WORKFLOW_DIR`)

## Decisions

### 1. Authentication: GitHub token validated in runtime middleware

Callers pass a GitHub PAT or `GITHUB_TOKEN` in the `Authorization: Bearer` header. The runtime middleware calls `GET https://api.github.com/user`, compares `response.login` against the `GITHUB_USER` env var.

**Why not oauth2-proxy?** oauth2-proxy handles browser-based OAuth flows (redirect → login → cookie session). It cannot validate opaque API tokens in bearer headers.

**Why not a separate auth proxy (Oathkeeper, Pomerium)?** Research found no off-the-shelf proxy that validates GitHub PATs against `/user` and checks identity. The validation is ~30 lines of middleware — a separate service adds deployment complexity for no benefit.

**Why not OIDC JWTs?** GitHub Actions OIDC tokens are only available inside Actions runners. Developers on workstations cannot obtain them, requiring two auth mechanisms instead of one.

### 2. Routing: Caddy skip-auth for /api/*

A new `handle /api/*` block in the Caddyfile routes directly to the runtime, bypassing oauth2-proxy's `forward_auth`. This matches the existing pattern for `/webhooks/*`.

### 3. Storage layout: events/ and workflows/ prefixes

Restructure the storage backend layout:
- `events/pending/` and `events/archive/` (moved from `pending/`, `archive/`)
- `workflows/{name}/manifest.json` and `workflows/{name}/actions/*.js`

This is a breaking change. No migration code — early-stage software.

### 4. Loader reads from storage backend, not filesystem

The loader is rewritten to use `StorageBackend.list()` and `StorageBackend.read()` instead of Node.js `readFile`/`readdir`. The FS backend's `list()` becomes recursive (using `readdir({ recursive: true })`) to match S3's inherent recursive listing behavior. `WORKFLOW_DIR` is removed.

Without a storage backend, uploaded workflows exist only in the `WorkflowRegistry` in memory.

### 5. WorkflowRegistry with incremental updates

A new `WorkflowRegistry` replaces the one-shot `registerWorkflows()` function. It holds a `Map<name, LoadedWorkflow>` and exposes derived indexes:
- `.actions` — flat `Action[]`
- `.events` — merged `Record<string, Schema>`
- `.jsonSchemas` — merged `Record<string, object>`

`register(name, workflow)` removes the old entry (if any), inserts the new one, and eagerly rebuilds all derived indexes. Consumers (scheduler, middleware, event source) query the registry on each tick/request instead of holding snapshot references.

**Why incremental over full rebuild?** Even though workflow count is small, incremental keeps the registry self-contained — it doesn't need to know about the storage backend or re-read files.

**Why eager over lazy rebuild?** Simplicity. The cost is negligible for single-digit workflows.

Trigger conflicts on override: when uploading workflow "foo", old "foo" triggers are removed first. If new triggers collide with another workflow's triggers, the new upload wins (override).

### 6. Upload-only mode, no build-time workflows

The runtime starts with an empty registry. Workflows are only loaded from the storage backend (on startup recovery) or via the upload endpoint. `WORKFLOW_DIR` is removed entirely.

### 7. Startup sequence: bus → recover → workflows → start

```
1. init storage backend (if configured)
2. init event bus + consumers (work queue, event store, persistence, logging)
3. recover events from storage backend
   → events fill work queue + event store
   → NO action execution (scheduler not started)
4. load workflows from storage backend → register into WorkflowRegistry
5. start scheduler + server
   → scheduler drains work queue, matches against registry
```

Recovery before workflow loading is safe because the scheduler (the only consumer that executes actions) hasn't started yet. Events land in the work queue but sit idle until step 5.

### 8. Bundle layout: actions/ subdirectory

Both in the tar.gz upload and in storage:
```
{name}/
  manifest.json
  actions/
    handleFoo.js
    handleBar.js
```

The vite-plugin output changes to match this layout.

### 9. Workflow name from createWorkflow("name")

The SDK's `createWorkflow()` gains a required first argument: the workflow name. The vite-plugin extracts this and writes it to the manifest's new `name` field. The upload endpoint uses this name to determine the storage path.

### 10. No storage backend = in-memory only

Same semantics as events today. Without a storage backend:
- Uploaded workflows live only in the WorkflowRegistry
- Events live only in the work queue and event store
- Everything is lost on restart

## Risks / Trade-offs

**[GitHub API availability]** → Every upload requires a call to `api.github.com`. If GitHub is down, uploads fail. Acceptable given low upload frequency and no caching requirement.

**[Breaking storage layout]** → Existing persistence data under `pending/`/`archive/` becomes unreadable. Mitigation: early-stage software, documented as breaking change, wipe persistence on upgrade.

**[No rollback on failed upload]** → If a workflow upload succeeds storage write but fails registry load (shouldn't happen given pre-validation), the storage has files the registry doesn't reflect. Mitigation: next startup reloads from storage, self-healing.

**[In-flight event ordering during hot reload]** → Actions already dequeued execute with old code while new events use updated actions. This is the intended behavior — no interruption of running work.

**[Single-user auth]** → Only one GitHub user can upload. Sufficient for current scale but limits future team use. Migration path: change `GITHUB_USER` to `GITHUB_USERS` (comma-separated) or switch to org membership check.

## Open Questions

None — all design decisions resolved during discovery.
