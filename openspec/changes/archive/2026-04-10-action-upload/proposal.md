## Why

Workflows are currently compiled at build time and baked into the container image. Deploying a workflow change requires a full image rebuild and container restart. An HTTP upload endpoint enables CI/CD pipelines and developers to deploy workflows independently of the runtime container lifecycle, with hot reload for zero-downtime updates.

## What Changes

- Add `POST /api/workflows` endpoint that accepts a tar.gz workflow bundle (manifest.json + actions/*.js), validates it, persists it to the storage backend, and hot-reloads it into the runtime
- Add GitHub token authentication middleware for the upload endpoint (validates against GitHub API, restricts to a configured user)
- **BREAKING**: Restructure storage backend layout from flat `pending/`/`archive/` to `events/pending/`/`events/archive/` + `workflows/{name}/`
- **BREAKING**: Remove `WORKFLOW_DIR` env var — runtime loads workflows from the storage backend (or holds them in memory if no backend configured) instead of from a local directory
- **BREAKING**: `createWorkflow("name")` — name becomes a required first argument in the SDK
- **BREAKING**: Manifest schema gains a required `name` field; bundle layout changes to `manifest.json` + `actions/<name>.js`
- Replace one-shot workflow registration with a `WorkflowRegistry` that supports incremental register/remove with eager index rebuilds, enabling hot reload
- Change startup sequence: event bus + recovery first, then workflow loading, then scheduler start

## Capabilities

### New Capabilities
- `action-upload`: HTTP endpoint for uploading workflow bundles with validation, storage, and hot reload
- `github-auth`: GitHub token authentication middleware for API endpoints
- `workflow-registry`: Incremental, mutable workflow registry replacing the one-shot startup registration

### Modified Capabilities
- `storage-backend`: Layout restructure (`events/` and `workflows/` prefixes), FS backend `list()` becomes recursive
- `workflow-manifest`: Add required `name` field, change bundle layout to use `actions/` subdirectory
- `sdk`: `createWorkflow("name")` requires name as first argument
- `vite-plugin`: Extract workflow name, write actions to `actions/` subdirectory in bundle output
- `runtime-config`: Remove `WORKFLOW_DIR`, add `GITHUB_USER`
- `workflow-loading`: Loader reads from storage backend instead of local filesystem

## Impact

- **packages/sdk**: `createWorkflow()` signature change (breaking for all workflow authors)
- **packages/vite-plugin**: Bundle output layout change (actions/ subdirectory, name in manifest)
- **packages/runtime**: New middleware (auth, upload), new WorkflowRegistry, loader rewrite, config change, storage layout change, startup sequence change
- **workflows/**: All existing workflows must add name to `createWorkflow()` call
- **infrastructure/**: Caddyfile needs `/api/*` route, Pulumi needs `GITHUB_USER` env var
- **Dependencies**: No new external dependencies expected (tar extraction via Node.js builtins, GitHub API via fetch)
