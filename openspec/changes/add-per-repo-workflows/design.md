## Context

The workflow-engine today treats the top-level isolation boundary as a single dimension called "tenant". Operationally, a tenant IS always a GitHub login — either an organization (e.g. `acme`) or a user account (e.g. `alice`) — because `isMember(user, tenant)` grants access when `tenant ∈ user.orgs || tenant === user.name`. So "tenant" is an abstract word for what GitHub itself calls an `owner`. Each tenant stores exactly one tarball (`workflows/<tenant>.tar.gz`) containing all workflows for all of that owner's repos, flat, under a single manifest.

Two pressures push us off this design:

1. **Real-world granularity is per-repo**, not per-owner. An owner has many repos; each repo has its own CI that publishes workflows independently; each repo's publish should be independent of sibling repos. Today a publish from `acme/repo-b` overwrites `acme/repo-a`'s workflows because they share a tarball.
2. **Naming overlap is about to get worse.** Adding a second dimension means URLs like `/api/workflows/:tenant/:repo` where `tenant` and `repo` carry nearly the same flavor of identifier. Using GitHub's own word — `owner` — removes the abstraction layer and makes `github.com/:owner/:repo ↔ /api/workflows/:owner/:repo` a one-to-one mental map.

The runtime's event store, trigger backends, persistence layout, auth middleware, dashboard, trigger UI, CLI, and webhook routes all key on the tenant dimension. Adding `repo` is not a local change; it's a cross-cutting scope expansion.

The codebase is pre-launch: there are no external webhook consumers with hard-coded URLs, no user sessions worth preserving, no archived invocation history worth migrating. This enables a hard cutover rather than a compatibility-layered rollout.

## Goals / Non-Goals

**Goals:**

- Bundle per repo, not per owner. Uploads from repo A do not affect repo B's workflows, even when both belong to the same owner.
- Auto-detect `owner/repo` from the git origin at CLI upload time. Zero configuration in the common case.
- Unify naming on GitHub's conventions: `owner`, `repo`, `login`. Remove "tenant" from the vocabulary.
- Preserve existing security invariants after the rename: every event store read is scope-bound; every upload/view is authorized against owner membership; cross-owner and cross-repo data are isolated.
- Make multi-repo UX visible at `/dashboard` and `/trigger` via a lazy-loaded collapsible tree (owner → repo → invocations).
- Make the dev environment (`pnpm start`) exercise the multi-repo path by default.

**Non-Goals:**

- Per-repo push-access verification via GitHub API (would require OAuth scope expansion to `repo` or `public_repo`; explicitly deferred).
- GitHub Enterprise support (`github.com` is hardcoded in auth; no change here).
- Explicit delete endpoint for repo bundles (deferred; overwriting an existing repo on upload is the only supported mutation).
- Backward compatibility: no alias flags, no nullable schema columns, no legacy decoder paths. Hard cutover.
- Cross-owner read gating based on private-repo visibility. Owner-membership remains the coarse read boundary.

## Decisions

### 1. Rename `tenant → owner`, `name → login`, include self in `orgs`

Three renames shipped together in the first commit:

- `tenant` → `owner` everywhere (types, functions, URL params, event fields, storage keys, spec prose, SECURITY.md invariant names).
- `UserContext.name` → `UserContext.login` (matches GitHub `/user` API field).
- `UserContext.orgs` is populated as `[user.login, ...githubOrgs]` on login, so `isMember(user, owner)` simplifies to `user.orgs.includes(owner)`.

**Alternatives considered:**

- Keep `tenant` internally, use `owner` only in URLs. Rejected: perpetual translation burden between user-facing and internal vocab; the abstraction layer provides no value because tenant always was an owner.
- Use `namespace` or `account` instead of `owner`. Rejected: `namespace` is VCS-agnostic (but non-GitHub is out of scope); `account` is awkward for orgs (GitHub's own docs call orgs "organizations", not "accounts").
- Rename `user.orgs` → `user.owners`. Rejected: reads as "owners of the user" (who owns the user?). Sticking with `orgs` — the list's semantics widen to "identities this user can act as," which is close enough to the GitHub endpoint name (`/user/orgs`) that the asymmetry is tolerable.

**Staging:** this rename lands as commit 1 of the PR; no behavior changes; spec-invisible at the requirement level (prose updates only). Commit 2 adds the `repo` dimension. Bundled in one PR per user request.

### 2. Storage layout: one tarball per `(owner, repo)`

Keys become `workflows/<owner>/<repo>.tar.gz`. Each upload replaces exactly that repo's bundle; sibling repos under the same owner are untouched.

**Alternatives considered:**

- One tenant-wide tarball with repo-subdirectories inside. Rejected: every upload becomes a read-modify-write of the entire owner's bundle — concurrency hazard, partial-upload risk, no per-repo atomicity.
- Flat key `workflows/<owner>_<repo>.tar.gz`. Rejected: prefix-listing per owner is harder; slashes are the natural hierarchical delimiter in object storage browsers.

**Recovery:** `registry.recover()` scans `workflows/` with depth-2 prefix listing; each `.tar.gz` file found is registered under its parsed `(owner, repo)` pair.

### 3. Upload URL: `POST /api/workflows/:owner/:repo`; manifest is repo-agnostic

The URL is the **sole** source of `(owner, repo)`. The manifest inside the tarball does not carry a `repository` field. The server stamps `owner` and `repo` from the path when persisting.

**Alternatives considered:**

- Manifest declares `repository`, server cross-checks against URL. Rejected: redundant validation; no extra expressive power; forces the build step to know the repo (harder to keep `vite` config repo-independent).

**Authorization:** `apiAuthMiddleware` + `requireOwnerMember()` (renamed from `requireTenantMember()`). No per-repo push-access check. Any authenticated member of `owner` can upload to any `<owner>/<repo>`. Rationale: OAuth scope expansion to `public_repo`/`repo` has meaningful privacy cost; the threat model's attacker is an external user, not a hostile org co-member.

### 4. CLI auto-detection via `git remote get-url origin`

Precedence at upload time:

1. `--repo <owner>/<name>` flag — win if passed.
2. `git remote get-url origin` — parse as a GitHub URL.
3. Error with actionable message.

Parser accepts HTTPS, SSH (`git@github.com:`), `ssh://` protocol forms, optional userinfo, optional `.git` suffix. Only `github.com` as host; anything else silently falls through to require `--repo` (user may have custom remotes unrelated to publication).

**Implementation:** shell out via `execFile('git', ['remote', 'get-url', 'origin'])`. No new npm dependency; `git` is already an assumed tool in the dev environment.

**CLI surface:**
- Remove `--tenant` flag entirely.
- Remove `WFE_TENANT` env var entirely.
- Add `--repo <owner/name>`.

This is intentionally a hard-break of the CLI contract; pre-launch means no third-party CI pipelines are broken.

### 5. Event schema: `InvocationEvent.owner` and `InvocationEvent.repo` both required

Sandbox emits `SandboxEvent` without either field; the executor's `sb.onEvent` widener stamps both before forwarding to the bus (parallel to how it stamps `tenant` today). Event store table gains `owner TEXT NOT NULL` and `repo TEXT NOT NULL` columns with an index on `(owner, repo)`.

**Alternatives considered:**

- Nullable `repo`. Rejected: queries scoped by `owner` only would match cross-repo rows, silently violating the isolation invariant. The scoping guarantee must be structural.
- Single combined `ownerRepo` field. Rejected: violates normalization; every query that filters by owner would need string splitting.

**Security invariant update:** SECURITY.md §2 R-8 (sandbox stamps only intrinsic event fields; runtime stamps `tenant`) extends to list both `owner` and `repo` as runtime-stamped.

### 6. EventStore.query accepts a list of scopes

Current signature: `query(tenant: string)` pre-binds `WHERE tenant = ?`.

New signature: `query(scopes: ReadonlyArray<{owner: string; repo: string}>)`. Internally compiles to `WHERE (owner, repo) IN ((?, ?), (?, ?), ...)`.

The call site (dashboard/trigger middleware) resolves the user's allow-list from membership: all `(owner, repo)` pairs under owners the user belongs to AND that have a registered bundle. The middleware is the policy boundary; the EventStore is a mechanism.

**Alternative considered:**

- Iterate single-scope queries in the handler and merge. Rejected: for a user with many repos, this multiplies round-trips to DuckDB and requires client-side sort-merge for timeline ordering. The scope list is small (≤N repos in ≤M orgs); a single `IN`-clause query is simpler and faster.

**Security invariant update:** SECURITY.md §1 I-T2 (renamed to cover owner+repo isolation) expands to specify that `query` is called only with scopes drawn from the user's validated allow-set; the middleware is responsible for not passing scopes the user isn't a member of. The invariant shifts from "pre-bound by implementation" to "caller-supplied from an audited allow-set" — still safe, but the audit burden moves into the middleware.

### 7. Dashboard and trigger UI: lazy HTMX collapsible tree

Three route levels for each of `/dashboard` and `/trigger`:

- `/dashboard` — shell + a `<details>` per owner the user can access; each summary shows a cheap "X invocations" count; expanding triggers `hx-get` to fetch that owner's repo list.
- `/dashboard/:owner` — shell + expanded owner node + lazy-loaded repo children.
- `/dashboard/:owner/:repo` — today's flat invocation list, unchanged in shape.

```
     /dashboard                /dashboard/:owner         /dashboard/:owner/:repo
     ─────────────             ─────────────────         ────────────────────────
     ▸ acme       (5)          ▾ acme                    Invocations (12)
     ▸ alice      (7)            ▸ foo           (3)     ─────────────────
                                  ▸ bar           (2)     ▸ deploy  12:44
                                                          ▸ deploy  12:30
                                                          ...
```

**Rendering:** server-side HTML with native `<details>`/`<summary>` elements (already a pattern in `ui/dashboard/page.ts` at line 124 for per-invocation flamegraph expansion). HTMX `hx-get` + `hx-trigger="toggle once"` fires lazy loads on expand. No Alpine required for the tree shell.

**Default expansion:** all collapsed, except when the user has exactly one owner (auto-expand it). Zero-state and one-owner cases are the common paths for solo users and deserve fewer clicks.

**Pagination:** per-leaf 100-row cap (inherits current behavior) with a "load more" affordance — a new `hx-get` button appended to the end of each repo's invocation list, firing a subsequent scoped query with an offset/cursor.

**Fragment endpoints:** new handlers return HTML fragments for tree levels (e.g. `GET /dashboard/:owner/repos` returns the collapsible list of repos for an owner). These are not a separate JSON API; they're HTMX fragment routes.

**Trigger UI parity:** `/trigger` mirrors the same three-level shape; leaf view is today's manual-trigger form per workflow/trigger, now scoped to `:owner/:repo`.

### 8. Webhook URL: `POST /webhooks/:owner/:repo/:workflow/:trigger`

Each path segment individually validated (`owner` against the owner regex, `repo` against the repo regex, `workflow` and `trigger` against existing rules). Public endpoint — no auth — as before (per SECURITY.md §3).

The hard-cutover deploy breaks any existing webhook URLs that users configured in their third-party tools; pre-launch posture means this is acceptable. If external integrations existed, they'd need to be re-registered with the new URL shape.

### 9. Migration: wipe `workflows/`, `archive/`, `pending/` prefixes on deploy

The persistence backend holds three prefixes:

- `workflows/<owner>.tar.gz` (old layout, obsolete)
- `archive/<invocationId>.json` (historical event records, missing `owner`/`repo`)
- `pending/<invocationId>/<seq>.json` (in-flight events, same)

All three get deleted as a one-shot cleanup before or during the first deploy of the new code. No legacy decoder in `scanArchive`, no nullable columns in the DuckDB schema, no `_legacy` synthetic repo marker. Rationale: the project is pre-launch; there is no production invocation history worth preserving, and any compat layer shipped now lives forever.

Session cookies invalidate automatically because `auth/key.ts` generates a fresh seal password on every pod restart (documented invariant; load-bearing for `replicas=1`). No version bump or explicit cookie migration needed.

### 10. Dev ergonomics: `scripts/dev.ts` uploads `demo.ts` twice

`pnpm start` uploads the single `demo.ts` file under both `local/demo` and `local/demo-advanced`. This exercises:

- Dashboard collapsible tree (two repo nodes under one owner)
- Workflow-name collision path (both bundles declare `runDemo` — must coexist because scope is `(owner, repo, workflow)`, not `(owner, workflow)`)
- Cron/http backend repo-keyed reconfigure

`demo.ts` remains the sole authoring reference per CLAUDE.md; no second source file. CLAUDE.md's "keep `demo.ts` in sync" rule is unchanged.

## Risks / Trade-offs

- **Risk:** EventStore.query scope-list shift widens the audit surface. Middleware must be trusted to only pass scopes from the user's validated allow-set; a bug that passes user-supplied `(owner, repo)` directly from the URL would leak cross-owner data.
  - **Mitigation:** centralize scope resolution in a single helper (`resolveQueryScopes(user) → Scope[]`) that never takes external input; require every `EventStore.query` call site to route through it; add a test that calling `query` with an unauthorized scope in an end-to-end route returns 404, not leaked data.

- **Risk:** Rename noise (~500 line changes across ~50 files) could mask a semantic bug sneaking into commit 1.
  - **Mitigation:** commit 1 is enforced to be pure rename; review criterion is "every hunk is a `tenant → owner` or `name → login` swap"; tests pass unchanged; type checker catches any accidental type drift.

- **Risk:** Git-remote parsing is fragile across rare URL formats (enterprise domain aliases, port-specified SSH, userinfo with embedded tokens).
  - **Mitigation:** unit test the parser across the documented URL format matrix; on any unrecognized form, fall through cleanly to requiring `--repo`; never panic or produce malformed `owner/repo`.

- **Risk:** Lazy HTMX tree fires N round-trips for a user with N owners, even when no invocations exist.
  - **Mitigation:** summary row caches a cheap aggregate count per owner/repo (one query at initial render); expand is only for invocation lists; zero-state owners show "no activity" inline without triggering a load.

- **Risk:** `demo.ts` uploaded twice under different repos means two different `workflowSha` values (bundle built once, uploaded twice). If the system assumes `workflowSha` is globally unique, this surfaces as a duplicate. Needs verification.
  - **Mitigation:** inspect the manifest schema's `sha` field usage — if it's keyed by `(owner, repo, workflow)`, duplicates across repos are fine; if it's globally unique, this is a bug to fix as part of commit 2.

- **Trade-off:** Owner-membership as the read boundary means any `acme` org member can see invocation runs for `acme/private-repo`, even if they can't read that repo on GitHub. Accepted as a conscious simplification; matches today's visibility model (just widened to include repo granularity).

- **Trade-off:** Hard cutover of event archive loses all historical invocation records. Accepted because pre-launch and because the alternative (legacy adapter in `scanArchive`) accrues tech debt forever.

## Migration Plan

Single PR, two commits:

**Commit 1 — Rename (spec-invisible refactor)**
1. Global symbol rename: `tenant → owner`, `Tenant → Owner`, `TenantState → OwnerState`, etc. Includes `validateTenant → validateOwner`, `tenantSet → ownerSet`, `requireTenantMember → requireOwnerMember`, `activeTenant → activeOwner`, `sortedTenants → sortedOwners`, `registerTenant → registerOwner`, `extractTenantTarGz → extractOwnerTarGz`, etc.
2. `UserContext.name → UserContext.login`.
3. Populate `UserContext.orgs` as `[login, ...githubOrgs]`; simplify `isMember` to single `orgs.includes(owner)` check.
4. Prose updates in `SECURITY.md` and `openspec/docs/*.md` (word "tenant" → "owner"); no invariant semantics change yet.
5. Rename URL params in route defs (`:tenant → :owner`) without adding the `:repo` segment yet.
6. All tests green; `pnpm validate` passes.

**Commit 2 — Add `repo` dimension (semantic change)**
7. Add `repo` parameter to registry API (`registerOwner` → accepts `(owner, repo, files)`); internal state becomes `Map<owner, Map<repo, OwnerRepoState>>`.
8. Update storage layout: `workflows/<owner>/<repo>.tar.gz`; recovery scans depth-2.
9. Update upload route to `POST /api/workflows/:owner/:repo`; update `upload.ts` handler.
10. Update webhook route to `POST /webhooks/:owner/:repo/:workflow/:trigger`; update `http-trigger` backend.
11. Add `owner TEXT NOT NULL`, `repo TEXT NOT NULL` columns + index to DuckDB schema; update `InvocationEvent` Zod schema.
12. Update executor `sb.onEvent` widener to stamp `repo` (already stamps `owner` from commit 1).
13. Update `EventStore.query` signature to accept scope list; centralize `resolveQueryScopes(user)` helper.
14. Update cron/http/manual trigger backends to key by `(owner, repo, workflow, trigger)`; scoped reconfigure.
15. Update CLI: remove `--tenant`/`WFE_TENANT`; add `--repo` flag and git-remote parser; update `UploadOptions` interface.
16. Update dashboard: three-level routes + HTMX tree fragments + per-leaf "load more"; `/dashboard` fragment endpoints (`GET /dashboard/:owner/repos`, etc.).
17. Update trigger UI: mirror dashboard drill-down.
18. Update `scripts/dev.ts` to upload `demo.ts` twice under `local/demo` + `local/demo-advanced`.
19. Update SECURITY.md: I-T2 expansion (owner + repo isolation), §3 webhook URL, §4 route regex pairs, §2 R-8 stamped fields.
20. Deploy prep: document the `workflows/`, `archive/`, `pending/` wipe as a runbook step.

**Rollback strategy:** revert the PR. Because cutover is hard (no migration state), a revert restores commit-1 rename-only state; a second revert removes the rename entirely. No data to restore — wiped archives stay wiped, but the system boots clean on the old code.

## Open Questions

- **Count aggregation on tree summaries**: the dashboard summary needs "X invocations" per owner and per repo at initial render. Is this one DuckDB aggregate query over the user's scope list, or N scoped queries? Design picks option A (single query with `GROUP BY owner, repo`), but the exact handler shape is deferred to implementation.
- **`workflowSha` uniqueness invariant**: `scripts/dev.ts` uploading `demo.ts` twice produces two bundles with the same workflow name but may share `workflowSha` (since source is identical). Need to confirm whether `sha` is an index key or purely informational. Default assumption: informational; verify during commit 2.
- **Cutover runbook ownership**: the one-shot wipe of `workflows/`, `archive/`, `pending/` prefixes — is this a `docs/infrastructure.md` addition, a `scripts/` helper, or a manual step at deploy time? Leaning toward a short `scripts/prune-legacy-storage.ts` executable invoked manually once, documented in `docs/infrastructure.md`.
