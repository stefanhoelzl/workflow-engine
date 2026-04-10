## 1. SDK + Manifest Schema Changes

- [x] 1.1 Add required `name: string` parameter to `createWorkflow()` in the SDK and propagate it through the workflow builder to `.compile()` output
- [x] 1.2 Add required `name` field to `ManifestSchema` in the SDK
- [x] 1.3 Update the cronitor workflow to use `createWorkflow("cronitor")`
- [x] 1.4 Update SDK and manifest tests

## 2. Vite Plugin: Bundle Layout Change

- [x] 2.1 Change vite-plugin to write action files to `actions/` subdirectory (e.g., `dist/cronitor/actions/handleCronitorEvent.js`)
- [x] 2.2 Write workflow name from `.compile()` into manifest.json `name` field
- [x] 2.3 Update manifest action `module` paths to use `actions/` prefix (e.g., `actions/handleCronitorEvent.js`)
- [x] 2.4 Update vite-plugin tests

## 3. Storage Backend Changes

- [x] 3.1 Make FS backend `list()` recursive using `readdir({ recursive: true })`
- [x] 3.2 Update persistence consumer to use `events/pending/` and `events/archive/` prefixes instead of `pending/` and `archive/`
- [x] 3.3 Update storage backend tests for recursive listing and new path prefixes
- [x] 3.4 Add crash recovery tests verifying events are recovered from `events/` prefixes

## 4. WorkflowRegistry

- [x] 4.1 Create `WorkflowRegistry` with `register(name, loadedWorkflow)`, `remove(name)`, and derived index properties (`.actions`, `.events`, `.jsonSchemas`)
- [x] 4.2 Implement eager rebuild of derived indexes on every register/remove
- [x] 4.3 Implement trigger conflict override behavior (last-write-wins)
- [x] 4.4 Add WorkflowRegistry unit tests (register, remove, replace, multi-workflow, trigger override)

## 5. Loader Rewrite

- [x] 5.1 Rewrite loader to read workflows from `StorageBackend` using `list("workflows/")` and `read()` instead of filesystem `readFile`/`readdir`
- [x] 5.2 Add loader function to parse workflow from in-memory archive data (for upload without storage backend)
- [x] 5.3 Remove `WORKFLOW_DIR` from config schema
- [x] 5.4 Update loader tests

## 6. GitHub Auth Middleware

- [x] 6.1 Implement Hono middleware that extracts `Authorization: Bearer` token, calls `GET https://api.github.com/user`, and compares `login` to `GITHUB_USER` config
- [x] 6.2 Add `GITHUB_USER` optional env var to config schema
- [x] 6.3 Add auth middleware tests (valid token, missing header, invalid token, wrong user)

## 7. Upload Endpoint

- [x] 7.1 Implement `POST /api/workflows` handler: decompress gzip, extract tar, validate manifest and action files
- [x] 7.2 On valid upload: write files to storage backend (if configured), load workflow, register into WorkflowRegistry
- [x] 7.3 Return correct status codes (204 success, 415 bad archive, 422 validation failure)
- [x] 7.4 Add upload endpoint tests (valid upload, invalid archive, missing files, manifest validation failure, no storage backend)

## 8. Startup Sequence

- [x] 8.1 Refactor `main.ts` init to follow new sequence: storage backend → event bus → recover → load workflows → start
- [x] 8.2 Replace `registerWorkflows()` with WorkflowRegistry, wire scheduler/middleware/eventSource to query registry
- [x] 8.3 Wire upload endpoint and auth middleware into the server

## 9. Infrastructure

- [ ] 9.1 Add `handle /api/*` block to Caddyfile routing to `app:8080` (infrastructure repo, not in this workspace)
- [ ] 9.2 Add `GITHUB_USER` env var to Pulumi app container configuration (infrastructure repo, not in this workspace)
- [x] 9.3 Remove `WORKFLOW_DIR` from start script and configuration
