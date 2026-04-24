## 1. Commit 1 — Rename tenant → owner (spec-invisible refactor)

This commit lands first. Every change in this section is a mechanical symbol or prose rename; no behavior changes, `pnpm validate` must pass without any runtime or test rewrites beyond symbol updates.

- [x] 1.1 Rename `UserContext.name` → `UserContext.login` across `auth/user-context.ts` and every consumer (search for `user.name`, `UserContext#name`)
- [x] 1.2 Populate `UserContext.orgs` as `[login, ...githubOrgs]` in the github provider's identity-resolve path (currently `auth/github-api.ts`)
- [x] 1.3 Populate `UserContext.orgs` as `[name, ...entryOrgs]` in the local provider's identity-resolve path (currently `auth/providers/local.ts`)
- [x] 1.4 Update `SessionPayload.name` → `SessionPayload.login` in `auth/session-cookie.ts`; update seal/unseal paths; update session middleware refresh path
- [x] 1.5 Simplify `isMember` in `auth/tenant.ts` to a single `Set.has(owner)` check (no longer ORs against `user.name`); rename function to reflect owner terminology in step 1.6
- [x] 1.6 Rename `auth/tenant.ts` → `auth/owner.ts`; `validateTenant` → `validateOwner`; `tenantSet` → `ownerSet`; `TENANT_REGEX` → `OWNER_REGEX`; update imports
- [x] 1.7 Rename `auth/tenant-mw.ts` → `auth/owner-mw.ts`; `requireTenantMember` → `requireOwnerMember`; update imports
- [x] 1.8 Rename `workflow-registry.ts` symbols: `registerTenant` → `registerOwner`, `TenantState` → `OwnerState`, `RegisterTenantOptions` → `RegisterOwnerOptions`, `extractTenantTarGz` → `extractOwnerTarGz`, `packTenantBundle` → `packOwnerBundle`, `readTenantBundle` → `readOwnerBundle`, `tenantFiles` → `ownerFiles`, `tenantManifest` → `ownerManifest`, `tenantStates` → `ownerStates`, `tenantMap` → `ownerMap`, `tenantBackend` → `ownerBackend`, `tenantSection` → `ownerSection`, `prepareTenantState` → `prepareOwnerState`, `cancelTenant` → `cancelOwner`
- [x] 1.9 Rename dashboard/trigger UI symbols: `activeTenant` → `activeOwner`, `sortedTenants` → `sortedOwners`, `resolveActiveTenant` → `resolveActiveOwner`, `renderTenantSelector` → `renderOwnerSelector`, URL param `:tenant` → `:owner` in route definitions (NOT yet adding `:repo`)
- [x] 1.10 Rename URL param `:tenant` → `:owner` in trigger backend middleware and webhook route definitions (NOT yet adding `:repo`)
- [x] 1.11 Rename `InvocationEvent.tenant` → `InvocationEvent.owner` in `packages/core/src/index.ts` Zod schema and TS type; update every reference in runtime, tests, and event-store DDL
- [x] 1.12 Rename event-store schema column `tenant` → `owner`; update `query(tenant)` signature to `query(owner)` (still single-scope); update every call site in dashboard/trigger middleware
- [x] 1.13 Rename executor stamping: `currentRun.tenant` → `currentRun.owner`; update `sb.onEvent` widener; update `Executor.invoke(tenant, ...)` → `Executor.invoke(owner, ...)`
- [x] 1.14 Rename trigger backend APIs: `reconfigure(tenant, entries)` → `reconfigure(owner, entries)` in http/cron/manual trigger sources (NOT yet adding `repo` — that lands in commit 2)
- [x] 1.15 Rename CLI `UploadOptions.tenant` → `UploadOptions.owner`; update `--tenant` flag to `--owner` temporarily (will be removed entirely in commit 2 in favor of `--repo`); update `WFE_TENANT` env var to `WFE_OWNER` temporarily
- [x] 1.16 Rename `scripts/dev.ts` to pass `owner: "local"` instead of `tenant: "local"`
- [x] 1.17 Rename tests: file names (`tenant.test.ts` → `owner.test.ts`, `tenant-mw.test.ts` → `owner-mw.test.ts`), test-helper symbols, test descriptions (search for the literal word "tenant")
- [x] 1.18 Update `SECURITY.md` prose: replace "tenant" with "owner" throughout, rename invariant I-T2 to I-OR (or similar), rename "Tenant Isolation" header to "Owner Isolation", update route regex table to reflect `:owner` (no `:repo` yet)
- [x] 1.19 Update `CLAUDE.md` security-invariants section: replace tenant references with owner; the regex values stay identical
- [x] 1.20 Update `openspec/docs/sandbox-plugin-authoring.md` prose references (word "tenant" → "owner")
- [x] 1.21 Run `pnpm validate` and verify all checks pass with zero behavior-changing diffs
- [x] 1.22 Git commit with message summarizing: "refactor: rename tenant → owner, user.name → user.login (spec-invisible)"

## 2. Commit 2 — Add repo dimension (semantic change)

- [x] 2.1 Add `repo` parameter to registry API: `registerOwner(owner, repo, files)`, `lookup(owner, repo, method, path)`
- [x] 2.2 Change internal registry state from `Map<owner, OwnerState>` to `Map<owner, Map<repo, OwnerRepoState>>`; add `OwnerRepoState` interface; keep legacy per-owner tracking only where it aids concurrency reasoning
- [x] 2.3 Update storage key format: `workflows/<owner>/<repo>.tar.gz`; update `persist` and tarball-ingest paths
- [x] 2.4 Update `recover()` to scan depth-2 keys under `workflows/`; parse `(owner, repo)` from key; ignore legacy depth-1 keys with a log warning (will be wiped as part of deploy cleanup)
- [x] 2.5 Add workflow-name uniqueness check at `(owner, repo)` scope (was `(owner)` scope); update validation failure message to name the offending workflow
- [x] 2.6 Update upload API route from `POST /api/workflows/:owner` to `POST /api/workflows/:owner/:repo`; update `requireOwnerMember()` to validate both `:owner` and `:repo` regexes on routes that declare the repo param
- [x] 2.7 Add repo regex constant: `REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/`; add `validateRepo` function; export both from the `auth/owner.ts` module (or a new `auth/repo.ts`)
- [x] 2.8 Update webhook route from `POST /webhooks/:owner/*` to `POST /webhooks/:owner/:repo/:workflow/:trigger`; update HTTP trigger middleware to validate both regexes and to look up registry by `(owner, repo, method, path)`
- [x] 2.9 Add `owner TEXT NOT NULL, repo TEXT NOT NULL` columns + `(owner, repo)` index to event-store DuckDB DDL; update `eventToRow` and `rowToEvent` serialization
- [x] 2.10 Change `EventStore.query` signature from `query(owner: string)` to `query(scopes: ReadonlyArray<{owner: string, repo: string}>)`; compile to `WHERE (owner, repo) IN (...)` using Kysely; reject empty scopes array
- [x] 2.11 Add `resolveQueryScopes(user, constraint?)` helper in `auth/` that returns the allow-list of `(owner, repo)` pairs derived from user's orgs ∩ registered bundles; middleware layer routes every `EventStore.query` call through it
- [x] 2.12 Add required `repo` field to `InvocationEvent` in `packages/core/src/index.ts`; update Zod schema (`z.string().regex(REPO_REGEX)`); update TS type
- [x] 2.13 Update executor's `sb.onEvent` widener to stamp `repo` alongside `owner`; update `Executor.invoke(owner, repo, workflow, descriptor, input, bundleSource, options?)` signature
- [x] 2.14 Update `buildFire` in registry to take `(owner, repo, workflow, descriptor, bundleSource, validate)` and pass both to `executor.invoke`
- [x] 2.15 Update trigger backend `reconfigure(owner, entries)` → `reconfigure(owner, repo, entries)` in http/cron/manual sources; update internal state keying from `Map<owner, ...>` to `Map<owner, Map<repo, ...>>`
- [x] 2.16 Update `TriggerEntry` interface to include `owner` and `repo` fields; update registry's entry construction
- [x] 2.17 Update trigger URL derivation: HTTP trigger public URL becomes `/webhooks/<owner>/<repo>/<workflow>/<trigger>`; update any URL-construction helpers used by the dashboard/trigger UI
- [x] 2.18 Add CLI `--repo <owner/name>` flag via `citty`; parse the `owner/name` string into separate `owner` and `repo` fields validated against their regexes
- [x] 2.19 Implement git-remote parser: `execFile('git', ['remote', 'get-url', 'origin'])`; recognize HTTPS, SSH-colon, SSH-protocol forms; strip userinfo; strip `.git` suffix; reject non-github.com hosts by silently falling through
- [x] 2.20 Unit-test the git-remote parser across the documented URL format matrix (10+ cases including: https/ssh/ssh-protocol, with/without .git, with/without userinfo, enterprise host, gitlab, no remote configured)
- [x] 2.21 CLI: wire detection order (`--repo` flag → git origin → error with actionable message naming `--repo` as remedy)
- [x] 2.22 Remove `--tenant` flag and `WFE_TENANT` env var handling from CLI (the rename-phase temporary `--owner`/`WFE_OWNER` also removed); clean up any fallback logic
- [x] 2.23 Update CLI upload path construction from `${url}/api/workflows/${owner}` to `${url}/api/workflows/${owner}/${repo}`; update `UploadOptions` interface to carry `owner` and `repo`
- [x] 2.24 Update programmatic `upload()` API signature to `{ cwd, url, owner, repo, user?, token? }`; reject invalid owner/repo with named field errors
- [x] 2.25 Update `scripts/dev.ts` to upload `demo.ts` twice — once to `local/demo` and once to `local/demo-advanced`; confirm the workflow-name collision path works (both uploads declare identical workflow names; both must coexist)
- [x] 2.26 Refactor dashboard routes: replace `GET /dashboard` (single-scope) with three routes `GET /dashboard`, `GET /dashboard/:owner`, `GET /dashboard/:owner/:repo`; each enforces owner-membership (leaf route validates repo regex); each builds its scope allow-list via `resolveQueryScopes`
- [x] 2.27 Add dashboard tree-fragment endpoints: `GET /dashboard/:owner/repos` (lazy-loaded owner expansion), `GET /dashboard/:owner/:repo/invocations` (lazy-loaded repo expansion), each returning an HTML fragment
- [x] 2.28 Implement collapsible-tree renderer using native `<details>` + HTMX `hx-trigger="toggle once"`; owner/repo summaries carry aggregate counts from a single server-side DuckDB query over the user's allow-list
- [x] 2.29 Implement auto-expand logic: owner `<details>` `open` when user has exactly one owner; repo `<details>` `open` when user has exactly one owner with exactly one repo
- [x] 2.30 Implement per-leaf pagination: 100-row cap, "load more" button with cursor-based pagination (`?cursor=` encoding last-rendered `(at, id)` tuple); fragment response replaces the button with next batch + new button or end marker
- [x] 2.31 Update flamegraph fragment endpoint from `GET /dashboard/invocations/:id/flamegraph` to `GET /dashboard/:owner/:repo/invocations/:id/flamegraph`; update `hx-get` URL construction on invocation rows
- [x] 2.32 Refactor trigger UI routes: mirror dashboard drill-down with `GET /trigger`, `GET /trigger/:owner`, `GET /trigger/:owner/:repo`, `POST /trigger/:owner/:repo/:workflow/:trigger`; same collapsible-tree pattern
- [x] 2.33 Update manual-trigger middleware to extract `(owner, repo, workflow, trigger)` from path and resolve the TriggerEntry via the manual source's scope-keyed accessor
- [x] 2.34 Update SECURITY.md: rewrite I-T2 (renamed) to specify owner+repo isolation; update §2 R-8 (event stamping) to list `owner` and `repo` as runtime-stamped fields; update §3 (webhook) to reflect new URL shape; update §4 (auth) route regex pairs to reference both regexes and the extended middleware signature
- [x] 2.35 Add a `scripts/prune-legacy-storage.ts` executable that clears `workflows/`, `archive/`, and `pending/` prefixes from the configured persistence backend; document in `docs/infrastructure.md` as a one-shot deploy-day step
- [x] 2.36 Update `workflow-manifest` spec prose and schema to reflect that manifests are repo-agnostic (no `repository` field on the manifest); confirm Zod schema stays without a `repository` field
- [x] 2.37 Run `pnpm validate`; fix any remaining test failures; ensure CLI integration tests exercise the new URL shape
- [x] 2.38 Update `workflow-registry.test.ts` to construct `(owner, repo)` pairs; ensure sibling-repo isolation scenarios are covered
- [x] 2.39 Add integration test: upload two bundles with the same workflow name to different `(owner, repo)` pairs; verify both coexist and fire independently
- [x] 2.40 Add security-boundary test: authenticated user for owner A attempts to upload to owner B's repo; verify 404 fail-closed
- [x] 2.41 Add security-boundary test: authenticated user queries dashboard `/dashboard/other-owner`; verify 404 (enumeration prevention)
- [x] 2.42 Add test: `EventStore.query([])` throws precondition error (empty scopes not allowed)
- [x] 2.43 Add test: `resolveQueryScopes` returns only `(owner, repo)` pairs where user ∈ owner's orgs AND bundle is registered
- [x] 2.44 Manually exercise `pnpm start`: verify dashboard shows `local` owner → two repos (`demo`, `demo-advanced`) → separate invocation lists; verify manual trigger fire from either repo works
- [x] 2.45 Git commit with message summarizing: "feat: scope workflow bundles by (owner, repo); breaks upload URL, storage, webhooks, dashboard"

## 3. Deploy and runbook

- [ ] 3.1 Execute `scripts/prune-legacy-storage.ts` against the staging environment's persistence backend before deploying
- [ ] 3.2 Deploy PR; verify pod restart invalidates session cookies; verify existing webhooks return 404 (external integrators must re-register with new URLs)
- [ ] 3.3 Smoke-test via `wfe upload` from a checkout of a real github.com repo; confirm URL auto-detection, successful upload, dashboard visibility
- [ ] 3.4 Repeat step 3.1 against production's persistence backend; deploy to production; smoke-test production
