## 1. Tenant model foundation

- [x] 1.1 Add `tenant` utility module in `packages/runtime/src/auth/` (or similar) exporting the identifier regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`, a `validateTenant(s): boolean`, and a `isMember(user, tenant): boolean` predicate
- [x] 1.2 Update `userMiddleware` / UserContext consumers to filter `orgs[]` and `name` through `validateTenant` when computing the tenant set
- [x] 1.3 Unit tests for `validateTenant`: valid names, traversal attempts, over-long, invalid chars, empty
- [x] 1.4 Unit tests for `isMember`: real-org membership, pseudo-tenant self, non-member, teams (must NOT grant access)

## 2. Core types + event shape

- [x] 2.1 Add required `tenant: string` field to `InvocationEvent` zod schema in `@workflow-engine/core`
- [x] 2.2 Update all event-emitting call sites to stamp `tenant` from the runner's immutable `tenant` property (sandbox `RunContext.tenant` → stamped in bridge-factory + worker)
- [x] 2.3 Add `tenant` to `WorkflowRunner` interface (immutable field set at construction)
- [x] 2.4 Update `recovery.ts` synthetic `trigger.error` to carry `tenant` from the first replayed event
- [ ] 2.5 Unit test: sandbox-originating spoofed tenant is explicitly ignored (behaviour is enforced at the runner level but a dedicated spoof test is not yet added)
- [x] 2.6 Unit test (crash recovery): recovery synthetic terminal carries the crashed invocation's tenant (integration.test.ts)

## 3. Storage + manifest format

- [x] 3.1 Extend `StorageBackend` interface with `writeBytes(path, data: Uint8Array)` and `readBytes(path): Promise<Uint8Array>`; implement for `fs.ts` and `s3.ts`
- [x] 3.2 Update `ManifestSchema` in core to the new tenant-manifest shape (`{ workflows: [{name, module, env, actions, triggers}, ...] }`); reject duplicate workflow names
- [x] 3.3 Export `WorkflowManifest` type alias from core for individual workflow entries
- [x] 3.4 Unit tests for the new `ManifestSchema`: valid, missing `workflows`, missing per-workflow required fields, duplicate name collision
- [x] 3.5 Update `vite-plugin` to produce a single tenant tarball at `dist/bundle.tar.gz` containing root `manifest.json` + `<name>.js` per workflow at the tarball root (no per-workflow dirs)
- [x] 3.6 Integration test: `vite-plugin` output for a workflow set produces a valid tenant tarball (`workflow-build.test.ts`)

> **REVIEW CHECKPOINT 1** — data model + storage surface. Confirm the new event envelope, manifest schema, and `StorageBackend.writeBytes` before building registry/upload on top.

## 4. Registry refactor to (tenant, name) keying

- [x] 4.1 `WorkflowRegistry.runnersByKey: Map<string, WorkflowRunner>` where key = `` `${tenant}/${name}` ``
- [x] 4.2 `lookupRunner(tenant, name)` across all callers
- [x] 4.3 `HttpTriggerRegistry.lookup(tenant, name, path, method)` keyed by composite
- [x] 4.4 `registerTenant(tenant, files, { tarballBytes })` persists `workflows/<tenant>.tar.gz` via temp key + `move()` before the in-memory swap; persist failure disposes freshly built sandboxes and leaves prior state intact
- [x] 4.5 `recover()` LISTs `workflows/*.tar.gz` and registers each tenant
- [x] 4.6 `WORKFLOWS_DIR` / `WORKFLOW_DIR` bootstrap removed; `main.ts` emits `workflows.dir-env-ignored` at warn level when set
- [x] 4.7 Unit tests: atomic replacement, same-name-two-tenants, lookup isolation, missing-module rejection + persistence round-trip + recover() from storage + skip-invalid-tenant-bundle
- [x] 4.8 Cross-tenant trigger routing test (`triggers/http.test.ts` — same path in two tenants coexists)

## 5. Hot-swap: busy-aware retirement (no refcount needed)

Per-workflow serialization (executor runQueue) guarantees at most one in-flight invocation per sandbox at any moment, so refcounting collapses to a single `isBusy` bool + `retiring` flag.

- [x] 5.1 `RunnerLifetime { sandbox, isBusy, retiring }` tracked per registered runner; `retiringLifetimes` set holds retired-but-busy sandboxes
- [x] 5.2 Runner's `onEvent` subscription flips `isBusy = true` on `trigger.request`
- [x] 5.3 Terminal events (`trigger.response` / `trigger.error`) flip `isBusy = false`; if `retiring`, dispose immediately
- [x] 5.4 `lookupRunner(tenant, name)` / trigger registry swap happens before old runner enters retirement → new invocations always bind to v2
- [x] 5.5 `dispose()` force-disposes active + retiring sandboxes on shutdown
- [x] 5.6 Unit test: in-flight invocation on v1 survives re-upload; still completes with status 200; new lookup returns v2 (`workflow-registry.test.ts`)
- [x] 5.7 Workflow removed by re-upload: `lookupRunner` returns undefined for new triggers (covered by the "re-registering a tenant atomically replaces its workflow set" test)
- [x] 5.8 Crash recovery: unchanged — cross-restart recovery uses the existing `recover.ts` synthetic `trigger.error` path (no hot-swap interaction across restarts)

> **REVIEW CHECKPOINT 2** — registry + hot-swap. Confirm the composite-key model, refcounting, and hot-swap semantics before wiring the API surface.

## 6. Upload endpoint (`POST /api/workflows/<tenant>`)

- [x] 6.1 Rewrite `packages/runtime/src/api/upload.ts` to accept `<tenant>` path param; validate against the tenant regex (404 on failure)
- [x] 6.2 Wire `userMiddleware` onto `/api/*` (runs after `githubAuthMiddleware`); `UserContext` available in the handler
- [x] 6.3 Upload handler enforces `isMember(user, tenant)`; 404 on non-member (indistinguishable from regex failure)
- [x] 6.4 Parse tarball via `extractTenantTarGz`, call `registry.registerTenant(tenant, files)`; 204 on success, 422 on validation failure, 415 on bad archive
- [x] 6.5 All-or-nothing enforced in `registerTenant` (validates every workflow's module exists before swap)
- [ ] 6.6 Dedicated integration test for 204 / non-member 404 / one-bad-workflow preserves prior bundle — not yet added
- [ ] 6.7 Dedicated enumeration-defense integration test — not yet added
- [x] 6.8 Old flat `POST /api/workflows` endpoint removed (replaced by `/api/workflows/:tenant`)

## 7. Webhook URL shape

- [x] 7.1 HTTP trigger middleware parses `/webhooks/<tenant>/<workflow-name>/<trigger-path>`; tenant and workflow-name regex-validated (404 on failure)
- [x] 7.2 Router looks up triggers by `(tenant, workflow-name, trigger-path)` composite
- [x] 7.3 Cross-tenant path coexistence covered by `triggers/http.test.ts`
- [x] 7.4 404 on unknown tenant/workflow/path — tested via existing 404 cases

## 8. Event store tenant column

- [x] 8.1 `tenant TEXT NOT NULL` column in DuckDB DDL
- [x] 8.2 `eventToRow` passes `event.tenant` through on every insert
- [x] 8.3 `EventsTable` Kysely schema includes `tenant`
- [x] 8.4 Unit test: `WHERE tenant = ?` returns only matching rows (`event-store.test.ts`)

> **REVIEW CHECKPOINT 3** — API + storage tenant surface live. Runtime is tenant-aware end-to-end for upload, trigger, events. Confirm before touching UI.

## 9. Dashboard + Trigger UI tenant selector

- [x] 9.1 Tenant selector in the shared `layout.ts` topbar, rendering `tenantSet(user)` (regex-filtered) alphabetically with the active tenant pre-selected
- [x] 9.2 Active tenant resolved from `?tenant=<name>` if in the user's tenant set, else first alphabetical; `renderDashboardPage` threads the resolved tenant into the HTMX fragment URL
- [x] 9.3 `fetchInvocationRows` applies `WHERE tenant = ?` on both the trigger.request query and the terminal-event follow-up query
- [x] 9.4 Trigger UI filters `triggerRegistry.list()` to entries whose `workflow.tenant` equals the active tenant; webhook cards now display `/webhooks/<tenant>/<workflow>/<path>`. Cross-tenant POST protection is handled at the public webhook route (unknown tenant → 404); there is no longer a `POST /trigger/:eventType` surface in the runtime (only GET)
- [x] 9.5 No-tenant users: selector renders an "(none)" stub, dashboard fragment returns the empty-state without querying, trigger UI shows "No triggers registered"
- [x] 9.6 When a user requests a tenant they're not in, the resolver silently falls back to the first legal tenant (no redirect, no data leak); selector reflects the resolved active tenant. (Accepted slight URL/selector mismatch in that edge case; redirect is a nice-to-have.)
- [x] 9.7 Unit/integration tests updated in `dashboard/middleware.test.ts` and `trigger/middleware.test.ts` for the tenant-scoped path
- [x] 9.8 Cross-tenant 404 is covered by the webhook middleware test (`triggers/http.test.ts`)

Also landed:
- `/static/tenant-selector.js`: CSP-compliant change handler to auto-submit the form (no inline `on*=` handlers).

## 10. CLI rewrite

- [x] 10.1 `--tenant` flag + `WFE_TENANT` env fallback; client-side regex validation
- [x] 10.2 vite-plugin emits single `dist/bundle.tar.gz`
- [x] 10.3 `upload.ts` POSTs once to `/api/workflows/<tenant>`
- [x] 10.4 Output formatting updated (`✓ <tenant>` / `✗ <tenant>` + indented details)
- [x] 10.5 Programmatic `upload({ cwd, url, tenant })` signature (scripts/dev.ts consumers still to adapt if they call it directly)
- [ ] 10.6 CLI-against-runtime E2E integration test — not added in this session

## 11. Security + docs

- [x] 11.1 `/SECURITY.md §3` updated with `/webhooks/<tenant>/<name>/<path>` shape and "identification, not authorization" clarification
- [x] 11.2 `/SECURITY.md §4` gains A12 threat + R-A12 tenant-membership mitigation (404-indistinguishable, middleware composition)
- [x] 11.3 `CLAUDE.md` security invariants list gains tenant-regex/membership check + cross-tenant query rules
- [x] 11.4 `CLAUDE.md` upgrade notes gain the multi-tenant migration (wipe pending/archive/workflows, re-upload via wfe)
- [x] 11.5 `infrastructure/Dockerfile` has no `WORKFLOW_DIR` — nothing to remove
- [x] 11.6 No `WORKFLOW_DIR` / `WORKFLOWS_DIR` in K8s manifests or docker-compose — verified via grep
- [x] 11.7 `openspec/project.md` updated (tenant tarball build, registry keying, webhook URL shape, upload endpoint)

## 12. Final validation

- [x] 12.1 `pnpm validate` passes (lint, format, type, tests) — 379/379 tests passing
- [x] 12.2 `pnpm exec openspec validate multi-tenant-workflows` passes
- [ ] 12.3 Manual E2E on `pnpm local:up` — deferred (infra-touching; needs running cluster)
- [ ] 12.4 Crash-recovery E2E on real storage — deferred
