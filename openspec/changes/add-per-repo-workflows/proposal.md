## Why

Today every upload replaces the entire tenant's workflow bundle: one tarball per tenant, one manifest, one flat namespace. Real users have multiple GitHub repositories under the same owner (org or user login), each with its own workflows, each publishing on its own CI cadence — but any upload from repo B clobbers repo A's workflows in the same tenant. The "tenant" abstraction also overloads the GitHub `owner` concept, producing naming friction (`tenant == owner`) that will only get worse with the new dimension.

The fix: scope workflows by `(owner, repo)` instead of by `tenant`, auto-detect the repo from the git origin at upload time, and rename `tenant → owner` throughout so the top-level namespace uses GitHub's own word for it.

## What Changes

Renames (mechanical, no behavior change):

- **BREAKING** Rename `tenant` → `owner` across code, URLs, specs, SECURITY.md, and type names (`TenantState` → `OwnerState`, `registerTenant` → `registerOwner`, etc.).
- **BREAKING** Rename `UserContext.name` → `UserContext.login` to match GitHub API vocabulary.
- `UserContext.orgs` now includes the user's own login alongside GitHub org memberships, so `isMember(user, owner)` collapses to `user.orgs.includes(owner)`.

New per-repo dimension (semantic):

- **BREAKING** Upload URL: `POST /api/workflows/:owner/:repo` (was `POST /api/workflows/:tenant`); manifest inside tarball stays repo-agnostic (URL is sole source).
- **BREAKING** Storage layout: `workflows/<owner>/<repo>.tar.gz` (was `workflows/<tenant>.tar.gz`). Each upload replaces only that repo's bundle.
- **BREAKING** Webhook URL: `POST /webhooks/:owner/:repo/:workflow/:trigger` (was `/webhooks/:tenant/:workflow`).
- **BREAKING** Dashboard and trigger routes gain drill-down: `/dashboard/:owner/:repo` → `/dashboard/:owner` → `/dashboard` (and same for `/trigger`); cross-scope views show a lazy HTMX-loaded collapsible tree (owners → repos → invocations).
- **BREAKING** `InvocationEvent` gains required `owner` and `repo` fields; executor stamps both in `sb.onEvent` widener.
- `EventStore.query` now accepts a list of `{owner, repo}` scopes; handlers resolve the user's allow-set from membership and validate before calling.
- Workflow names are unique within `(owner, repo)` (previously within tenant), so two repos under the same owner may each have a workflow named `deploy`.
- Trigger backends (cron, http, manual) are keyed by `(owner, repo, workflow, trigger)`; reconfigure scoped per upload.

CLI:

- **BREAKING** Remove `--tenant` flag and `WFE_TENANT` env var.
- Add `--repo <owner/name>` flag; CLI auto-detects from `git remote get-url origin` when flag is absent. Non-github.com origins silently fall through to requiring `--repo`. Shell-out to `git` (no new dependency).

Authorization:

- Upload auth stays owner-membership only; no OAuth scope expansion, no per-repo push-access check via GitHub API. Tenant-member can publish to any `<owner>/<repo>` under owners they belong to.
- Unknown scope returns `200` with empty state if the user is a member of the owner; `404` otherwise (enumeration prevention, mirrors existing tenant-missing response).
- Local auth: the local user can publish to any `<login>/<repo>`; no repo list required.

Migration (pre-launch, hard cutover):

- **BREAKING** On deploy, wipe `workflows/`, `archive/`, and `pending/` prefixes in the persistence backend; no legacy adapter in `scanArchive`, no nullable columns.
- **BREAKING** All outstanding session cookies invalidate automatically on pod restart (existing behavior: in-memory seal key); users re-authenticate once.

Dev experience:

- `scripts/dev.ts` uploads `demo.ts` twice under `local/demo` and `local/demo-advanced`, so the dashboard tree and cross-repo workflow-name collision paths are exercised on every `pnpm start`. `demo.ts` remains the canonical authoring reference.

## Capabilities

### New Capabilities

None. This is a modification across existing specs, not a new capability.

### Modified Capabilities

- `workflow-registry`: registry state keyed by `(owner, repo)`; per-repo reconfigure; recovery scans `workflows/<owner>/<repo>.tar.gz` keys; workflow names unique within `(owner, repo)`.
- `action-upload`: new URL shape `POST /api/workflows/:owner/:repo`; payload unchanged but scope derived from path; remove `--tenant` parameter from request contract.
- `cli`: remove `--tenant`/`WFE_TENANT`; add `--repo` flag; add git-remote detection with documented URL-format support (https/ssh, with/without `.git`, userinfo stripping); github.com-only.
- `auth`: `UserContext` shape changes (`login` replaces `name`; `orgs` contains `[login, ...memberships]`); `isMember(user, owner)` becomes a single `Set.has` check.
- `event-store`: schema gains `owner` and `repo` columns; `query` API accepts an allow-list of `{owner, repo}` scopes; all reads scoped.
- `invocations`: `InvocationEvent` adds required `owner` and `repo` fields; executor stamps both at the sandbox-boundary widener.
- `dashboard-list-view`: add drill-down routes `/dashboard`, `/dashboard/:owner`, `/dashboard/:owner/:repo`; lazy HTMX-loaded collapsible tree (owners → repos → invocations); per-leaf 100-row cap with "load more" affordance; auto-expand when user has exactly one owner.
- `trigger-ui`: mirror dashboard drill-down for `/trigger` routes; triggers grouped by owner → repo.
- `http-trigger`: webhook URL shape `POST /webhooks/:owner/:repo/:workflow/:trigger`.
- `webhooks-status`: status endpoint paths updated to match new webhook shape.
- `cron-trigger`: trigger entries keyed by `(owner, repo, workflow, trigger)`; reconfigure called per upload scope.
- `manual-trigger`: trigger identity includes `owner` and `repo`; trigger URL segments updated.
- `triggers`: overall trigger identity includes `owner` and `repo` dimensions.
- `executor`: `sb.onEvent` widener stamps `owner` and `repo` alongside `tenant` → renamed to `owner`.

## Impact

Code:
- `packages/runtime/src/workflow-registry.ts` (largest single-file impact, ~69 `tenant` references)
- `packages/runtime/src/auth/` (UserContext shape, isMember, session cookie payload)
- `packages/runtime/src/api/upload.ts` + `packages/runtime/src/api/index.ts` (URL shape, middleware chain)
- `packages/runtime/src/event-bus/event-store.ts` (schema + query API)
- `packages/runtime/src/executor/index.ts` (event stamping)
- `packages/runtime/src/ui/dashboard/` + `packages/runtime/src/ui/trigger/` (drill-down routes + tree rendering)
- `packages/runtime/src/triggers/http.ts` + `cron.ts` + `manual.ts` (repo-keyed backends + webhook URL shape)
- `packages/sdk/src/cli/cli.ts` + `upload.ts` (flag removal, --repo flag, git detection)
- `scripts/dev.ts` (dual-upload of demo.ts)
- `packages/core/src/index.ts` (`InvocationEvent` schema)

Specs:
- 13 modified spec deltas (see Capabilities section)
- `SECURITY.md`: §1 I-T2 (tenant → owner + repo), §3 (webhook URL), §4 (authorization path, route regex pairs), §5 (anywhere tenant is quoted), plus prose sweeps

Dependencies:
- No new dependencies. Shell-out to existing `git` binary for remote detection.

Infrastructure / ops:
- Pre-launch cutover task: clear `workflows/`, `archive/`, `pending/` prefixes in S2/S3 on first deploy of this change.
- No Traefik/ingress changes — all route shape changes are inside the runtime app.

Out of scope (deferred):
- `DELETE /api/workflows/:owner/:repo` endpoint for explicit repo teardown.
- Per-repo push-access verification via GitHub API (would require OAuth scope expansion).
- GitHub Enterprise support (`github.com` hardcoded in auth; out of scope confirmed).
- Cookie-based "last used (owner, repo)" remembered state.
- Read-visibility tightening beyond owner-membership (e.g. filtering private repos via GitHub read access).
