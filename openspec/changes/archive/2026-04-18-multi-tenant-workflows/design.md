## Context

The workflow engine today uses a single, flat namespace for workflows:

- `WorkflowRegistry.runnersByName: Map<string, WorkflowRunner>` is keyed by workflow name only (`packages/runtime/src/workflow-registry.ts:458`).
- Upload (`POST /api/workflows`) replaces a workflow by name; registry boots from `WORKFLOWS_DIR` at startup (`packages/runtime/src/main.ts:144`).
- Invocation events (`pending/<id>.json`, `archive/<id>.json`) carry `workflow` and `workflowSha`, but no ownership field.
- Dashboard + Trigger UIs run under oauth2-proxy forward-auth, which populates `X-Auth-Request-User`, `X-Auth-Request-Email`, `X-Auth-Request-Groups`; `userMiddleware` (`packages/runtime/src/auth/user.ts:93`) parses groups into `user.orgs` (plain names) and `user.teams` (format `org:slug`). The same middleware also resolves `user.orgs` for Bearer-token API callers by hitting `https://api.github.com/user/orgs` (`auth/user.ts:52-64`).
- `/api/*` is additionally allow-list-gated by `githubAuthMiddleware` which only checks `GITHUB_USER` membership (`packages/runtime/src/api/auth.ts:21`).
- Recovery (`packages/runtime/src/recovery.ts:42`) on restart replays pending events and emits a synthetic `trigger.error { kind: "engine_crashed" }`; in-flight invocations do not resume execution across a restart.
- SECURITY.md §3 makes `/webhooks/*` public by design; §4 documents the dual auth model.

The change introduces a tenant dimension that pervades registry, storage, events, URLs, and UI — but intentionally reuses the identity signal (`user.orgs`, `user.name`) that both auth paths already surface. No new IdP, no membership DB.

## Goals / Non-Goals

**Goals:**
- Every workflow is owned by exactly one tenant; a tenant is either a real GitHub org / oauth2-proxy group, or a per-user pseudo-tenant equal to the user's login.
- `/api/workflows/<tenant>` can only be called by a caller who is a member of `<tenant>`.
- Dashboard + Trigger UIs scope their content to a user-selected tenant.
- Webhook URLs disambiguate tenants and workflows in the path; triggering remains publicly accessible (SECURITY.md §3).
- Live re-upload (`POST /api/workflows/<tenant>`) atomically swaps the tenant's workflow set without killing in-flight invocations.
- The design reuses existing primitives (`UserContext`, `StorageBackend`, DuckDB event-store) and adds no new persistence surface.

**Non-Goals:**
- No teams (the `team` dimension from `UserContext` is not used; `X-Auth-Request-Groups` entries containing `:` are filtered out of tenant resolution).
- No per-workflow ACL, role-based access, or share-with lists. Single owner, single tier.
- No management API (no `GET`, no `DELETE`); upload-replaces-all is the only lifecycle primitive.
- No cross-restart version pinning. In-flight invocations that crash are terminated by the existing `recovery.recover()` synthetic-error path; there is no attempt to resume them on a pinned bundle.
- No storage-level compare-and-swap (last-write-wins on concurrent uploads; posture A: 1 tenant = 1 repo = 1 deployer).
- No tenant-name-collision resolution between real orgs and user pseudo-orgs. GitHub's namespace already prevents user/org collisions; for oauth2-proxy groups from other IdPs the assumption is that group names and user logins are drawn from disjoint pools. Violating this is operator misconfiguration.
- No CAS for upload atomicity; failures mid-write are handled by a temp-key + `move()` rename dance on the single tenant bundle.
- No CLI diff / pre-upload preview.

## Decisions

### D1 — Tenant is a single-tier identifier, sourced from `UserContext`

A tenant is a string. Validation regex: `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`. A user is a member of tenant `t` iff `user.orgs.includes(t) || user.name === t`. This composes the real-orgs and personal-pseudo-org decision into one predicate.

**Why single-tier over user+team+org:** the existing `UserContext` already splits `orgs[]` vs `teams[]` by the presence of `:` in group names; multi-tier tenancy would require operators to pick a dimension (or both) on every request. One tier is the smallest model that expresses "mine vs. the org's" and matches what real use cases need on this deployment.

**Why reuse `user.name` as the pseudo-tenant** (vs. a reserved prefix like `user:<login>`): GitHub ensures user logins and org names don't collide in its namespace; oauth2-proxy group names are expected to be drawn from a disjoint pool. A reserved prefix would require escaping in URLs and storage keys without any safety gain in the intended deployment model. Operators on non-GitHub IdPs whose group names collide with usernames must pick disjoint namespaces.

### D2 — Bundle = whole tenant, uploaded atomically

`POST /api/workflows/<tenant>` takes a tarball containing **all** of the tenant's workflows. The server parses, validates every workflow's manifest, and either swaps the entire set in or rejects the upload (**all-or-nothing**).

**Why whole-tenant over per-workflow:** matches a "1 tenant = 1 repo = 1 deployer" mental model. Deletion becomes implicit (drop a workflow from the source, re-upload, it's gone). No separate `DELETE` endpoint required. Concurrent multi-dev deploys to the same tenant are out of scope (non-goal; posture A).

**Why atomic over best-effort:** storage never contains a half-valid tenant. The client sees one 4xx with all issues at once, not a partial-apply to reconcile.

### D3 — Tarball: root `manifest.json` + flat `.js` files

```
tenant.tar.gz
├── manifest.json         # { workflows: [{ name, module, actions, triggers }, ...] }
├── daily-report.js
├── nightly-sync.js
└── weekly-cleanup.js
```

`manifest.json` is a **new** schema: a root `workflows: [...]` array, with each entry carrying the fields of today's per-workflow manifest (`name`, `module`, `actions`, `triggers`). The existing per-workflow `<name>/manifest.json` layout is removed.

**Why root manifest over per-workflow manifests:** one parse step, one validation pass. The tarball becomes cohesive (the whole tenant is one document), which matches the atomic-upload semantic.

### D4 — Bundle persistence via `StorageBackend` at `workflows/<tenant>.tar.gz`

The uploaded tarball is written to the storage backend at key `workflows/<tenant>.tar.gz`. Startup LISTs `workflows/`, reads each tenant's bundle, builds the registry. `WORKFLOWS_DIR` bootstrap is removed.

**Atomicity on write:** the upload handler writes to a temp key (`workflows/<tenant>.tar.gz.upload-<ulid>`) then calls `StorageBackend.move()` to the final key. Both FS and S3 `move()` implementations are atomic at the key-swap level. No CAS required for concurrent-writer defense (non-goal).

**Binary storage:** the current `StorageBackend.write(path, data: string)` is text-only. Two paths forward:
- **Option A (recommended)**: extend `StorageBackend` with `writeBytes(path, data: Uint8Array)` and `readBytes(path): Promise<Uint8Array>`. Both FS and S3 backends support this trivially.
- **Option B**: base64-encode the tarball as text. Ugly; inflates storage ~33%; forces everyone reading the key to decode.

The spec delta will mandate Option A.

### D5 — Registry keyed by `(tenant, name)`; HTTP triggers by `(tenant, name, path)`

```
WorkflowRegistry:
  runnersByKey: Map<`${tenant}/${name}`, WorkflowRunner>    // composite key
  sandboxesByKey: Map<`${tenant}/${name}`, Sandbox>

HttpTriggerRegistry:
  byPath: Map<`${tenant}/${name}/${path}`, TriggerBinding>
```

`lookupRunner(workflowName)` becomes `lookupRunner(tenant, name)`. The trigger registry router matches `/webhooks/<tenant>/<workflow-name>/<path>` and looks up by composite key.

**Why composite string key over nested Map:** lookup is O(1) either way; composite keys simplify iteration (e.g., "all runners for tenant X" is `Array.from(map.keys()).filter(k => k.startsWith(tenant + "/"))`, though a per-tenant sub-index is trivial to maintain if needed).

### D6 — `InvocationEvent.tenant` stamped by the Runner

```ts
interface InvocationEvent {
  ...existing fields...
  tenant: string;   // required; matches the runner's owning tenant
}
```

Every event — trigger, action, terminal — carries `tenant`. The `Runner` holds `tenant` as an immutable field set at construction; `emit()` stamps it on every envelope before hitting the bus. Same pattern as the existing `workflowSha` field.

**DuckDB event-store** gains a `tenant` column (schema migration = wipe, since we wipe pending/archive anyway). All filter queries add `WHERE tenant = ?`; dashboard listing uses it for the selector.

### D7 — Webhook URL: `/webhooks/<tenant>/<workflow-name>/<trigger-path>`

```
/webhooks/acme/daily-report/github-push
          └─┬─┘ └────┬────┘ └────┬─────┘
          tenant  workflow    descriptor
                              path (unchanged)
```

**Why include workflow-name in the URL:** within one tenant, two workflows may declare the same trigger descriptor path. The URL must disambiguate. `(tenant, name, path)` is the registry key.

**Still public (SECURITY.md §3):** tenant prefix is identification, not authorization. Anyone who holds the URL can trigger. Unchanged invariant.

### D8 — Hot-swap via refcounted runners

```
Re-upload on tenant T while inv-A is in flight on runner_v1:

  1. Parse + validate new bundle (atomic; reject if any workflow bad)
  2. Build new runners + sandboxes (runner_v2 set) in background
  3. Under a short lock:
     a. For each workflow in T, swap trigger-registry entry to v2
     b. Move v1 runners to a "retiring" set; each carries refcount = #in-flight invocations bound to it
     c. Swap registry.runnersByKey entries to v2
  4. inv-A continues running on sandbox_v1 (holds direct reference)
  5. New inv-B triggered → looks up v2 → binds to sandbox_v2
  6. inv-A emits terminal → refcount(runner_v1) decrements; at 0, dispose(sandbox_v1)
```

**Latest-at-dispatch:** when an in-flight invocation dispatches a sub-invocation (e.g. via an HTTP trigger to another workflow in the same tenant), the dispatched invocation binds to the *current* runner in the registry (v2), not the v1 of its caller. Pin protects the running invocation from being ripped out from under itself; newly dispatched work is new work.

**Cross-restart:** there is no cross-restart pin. The existing `recovery.recover()` logic (`packages/runtime/src/recovery.ts:42`) already emits synthetic `trigger.error { kind: "engine_crashed" }` for any pending invocation on boot. Nothing about multi-tenancy changes this.

**Sequence diagram — live re-upload:**

```
   Client                   Upload Handler        Registry          Running Runner v1
     │                            │                  │                     │
     │  POST /api/workflows/T     │                  │                     │
     │──────(tarball v2)─────────▶│                  │                     │
     │                            │ parse + validate │                     │
     │                            │ (all-or-nothing) │                     │
     │                            │                  │                     │
     │                            │ build v2 runners │                     │
     │                            │──────────────▶   │                     │
     │                            │                  │ swap triggers→v2    │
     │                            │                  │ v1 → retiring set   │
     │                            │                  │ refcount(v1) frozen │
     │                            │                  │                     │
     │◀────── 204 No Content ─────│                  │                     │
     │                            │                  │                     │
     │                            │                  │       ...inv-A emits terminal...
     │                            │                  │◀────────────────────│
     │                            │                  │ refcount(v1) == 0 → dispose
```

### D9 — Upload auth: membership + allow-list

The `/api/workflows/<tenant>` handler chain, top to bottom:

1. `githubAuthMiddleware` — Bearer token validates; caller's login must be in `GITHUB_USER`. (Unchanged: gates who can use the engine at all.)
2. `userMiddleware` — resolves `user.orgs`, `user.name` (already fetches GitHub orgs for Bearer-token callers; cached per-request only).
3. Route handler — validates `tenant` against the charset regex; rejects 404 if `user.orgs.includes(tenant) || user.name === tenant` is false (404 not 403 to avoid tenant enumeration).

**Why 404 over 403:** membership check leaking info ("this tenant exists, you just can't write to it") is an enumeration surface. 404 for both "tenant doesn't exist" and "you're not a member" collapses them into one response.

### D10 — Dashboard + Trigger: active tenant selector

Top bar on `/dashboard` and `/trigger`:

```
  ┌──────────────────────────────────────────────────────┐
  │  [Tenant: ▼ acme    ]   user: stefan-hoelzl          │
  └──────────────────────────────────────────────────────┘
```

The selector is populated from `user.orgs ∪ {user.name}`. Selected tenant is passed as a query param (e.g. `?tenant=acme`) or a session cookie — **decision deferred to spec delta**. All rendered content filters by that tenant server-side (`WHERE tenant = ?` on events; `runners.filter(r => r.tenant === t)` for triggers).

**Empty-state:** user with no orgs and zero personal workflows sees an empty selector + empty page. Acceptable.

### D11 — Dev seeding via `wfe upload`

`WORKFLOWS_DIR` is removed, so `pnpm local:up` no longer auto-populates the registry. Developers use `wfe upload` against the local stack after bring-up. `CLAUDE.md` commands section gains a note. No new automation.

### D12 — Migration is a hard break

On upgrade:
1. Operator wipes `pending/` and `archive/` prefixes on the storage backend.
2. Operator wipes the old `workflows/` prefix (if any persisted bundles from a prior change exist).
3. DuckDB event-store boots empty, rebuilds from the (now empty) archive.
4. Users re-upload via `wfe upload` with the new per-tenant tarball.
5. `CLAUDE.md` "Upgrade notes" section documents this alongside the existing monotonic-timestamps note.

No dual-read, no backfill, no grace period.

## Risks / Trade-offs

- **[Last-write-wins on concurrent uploads silently drops edits]** → Documented as posture-A assumption (1 tenant = 1 repo = 1 deployer). `wfe upload` prints `"Replacing N workflows in <tenant>"` as a human-visible cue. If posture B/C materializes later, revisit with If-Match CAS.
- **[Refcounting leaks sandboxes if terminal events are missed]** → Sandboxes for retired runners pile up in memory if an invocation never emits a terminal event (e.g. bug, infinite loop). Mitigation: (a) existing invocation-timeout mechanisms still fire terminal events; (b) runtime logs `workflow-registry.retiring` with refcount periodically; (c) dispose path also runs on process shutdown.
- **[Concurrent re-uploads on the same tenant race on move()]** → Two simultaneous POSTs to `/api/workflows/acme` from the same user. Second write overwrites first. Acceptable for posture A. If it matters later, wrap the upload handler in a per-tenant mutex.
- **[Tenant enumeration via 404 vs 401 timing]** → Handler returns 404 for both "invalid tenant string" and "not a member." Response body is identical. Timing differences (validation is synchronous, membership check is a Set lookup) are in microseconds; no realistic side-channel.
- **[Recovery emits `engine_crashed` for invocations whose bundle was replaced]** → If a tenant's bundle is replaced while an invocation is pending on disk and then the process crashes, recovery will replay events + emit synthetic `trigger.error`. This is the existing behavior; multi-tenancy doesn't regress it, but it's worth documenting that "re-upload then crash" cleanly terminates with `engine_crashed` rather than attempting to resume on either v1 or v2.
- **[Dashboard shows nothing for users with no orgs and no uploads]** → By design. If an empty state is confusing, the UI copy should spell out "upload a workflow to `<your-login>` or join an org to see content here."
- **[GitHub API rate-limit amplification]** → `userMiddleware` already fetches `/user/orgs` per request for Bearer-token callers. For an API-heavy deployment this adds to existing rate-limit pressure. No mitigation in this change; SECURITY.md A7/A8 already names the risk.
- **[Legacy `WORKFLOWS_DIR` in env will silently be ignored]** → On first boot after upgrade, an operator who still has `WORKFLOWS_DIR` set may expect seeding. The startup logger must emit a loud warn if `WORKFLOWS_DIR` is set, telling the operator that bootstrap is now storage-only and that `wfe upload` is the migration path.
