## Why

Queues are the only piece of runtime persistence still living on the filesystem (NDJSON files under `<root>/queues/...`), while every other durable surface — events, manifests, sessions — lives in `events.duckdb`. The filesystem implementation requires its own fsync/rename atomic-pop dance, path-traversal defenses, partial-line-tolerant inspection, and a boot reconciliation sweep that walks the queue subtree. Moving queues into the existing DuckDB instance collapses all of that into table semantics, unifies the storage tech (one file to back up, one connection pool to reason about), and unlocks per-item provenance metadata that the NDJSON format cannot carry. It also dramatically simplifies the `/queue` read-only UI: SQL replaces 100 lines of NDJSON parsing.

## What Changes

- **BREAKING**: Existing NDJSON queue files at `<PERSISTENCE_PATH>/queues/**` are abandoned. Per-tenant data does not migrate; on first boot after upgrade, every queue starts empty. Documented in `docs/upgrades.md`.
- Queue contents move from per-(owner,repo,workflow,queueName) NDJSON files to a single `queue_items` table in the existing `events.duckdb` database.
- Queue logic moves from the sandbox-stdlib worker (which did direct `fsOpen`/`fsync`/`rename` syscalls) to a host-side bridge. The in-sandbox worker collapses to a thin RPC proxy that forwards `put`/`get` over the existing host-call bridge.
- Schema validators (Zod, rehydrated from JSON Schemas) move from sandbox-side config to host-side, rehydrated once at sandbox construction. The sandbox-stdlib worker no longer carries validators.
- Each row gains provenance metadata stamped by the bridge: `enqueued_at` (TIMESTAMPTZ), `invocation_id`, `trigger_kind` (open string, no enum), `trigger_name`. Metadata is visible in the `/queue` UI but NOT exposed to guest code via `get()` — the guest contract `Queue<T> { put(T), get(): T | undefined }` is unchanged.
- New tenant-scope guard: a typed accessor requires `(owner, repo, workflow, queue)` at the type level on every host-side queue access. Raw `db.selectFrom("queue_items")` is forbidden by a lint rule. This is stronger than the existing `EventStore.query` scope check and addresses the cross-tenant leak class flagged in `SECURITY.md` §4.
- `QueueGone` semantics shift from "ENOENT from open()" to "queue name not in current manifest's declared set" — bridge consults the workflow registry's live manifest on every op (cheap `Set.has`). Sandbox's frozen `declaredQueues` becomes fail-fast only; the registry is source of truth.
- `/queue` UI items render via a new shared `EntryRow` component (extracted from `/invocations`): collapsible row with chevron, kind icon (existing `TriggerKindIcon`), `›`-separated identity, right-aligned relative age. Collapsed row shows no JSON preview. Expanded body renders via the existing `wfeJsonTree` Alpine component.
- `QueueSchemaMismatch` error payload (and the corresponding `system.error` event) gains producer metadata fields for operator root-cause attribution. Success-path `queue.get` events do NOT carry producer metadata (status-quo logging preserved).
- Upload-time queue lifecycle simplifies: adding a queue declaration has no row-level effect (manifest is sole declaration); removing a declaration `DELETE`s rows for the tuple. Boot reconciliation collapses to one `DELETE … WHERE NOT IN (manifest tuples)`.
- **REMOVED**: Path-traversal defense in depth (queue name is a column value, not a path segment). Host-side read-only inspection requirements (partial-line tolerance, rename safety, O_NOFOLLOW) — MVCC SELECTs supersede.

## Capabilities

### New Capabilities

(none — every change extends or modifies existing specs)

### Modified Capabilities

- `queues`: storage layout, durability mechanism, upload-time lifecycle, boot reconciliation, QueueGone semantics, plugin config shape, and schema-on-get error payload all rewrite. Path-traversal defense and host-side read-only inspection requirements are removed. New requirements added for tenant-scoped accessor and item provenance metadata.
- `queues-ui`: items fragment row layout updates to use the shared `EntryRow` component with metadata header; no JSON preview in collapsed row; expanded body uses `wfeJsonTree`. Scope routing, auth, and pagination requirements unchanged.
- `ui-foundation`: new requirement mandating a single shared `EntryRow` component for any UI surface that renders an expandable list of records (invocations, queue items, future similar surfaces).

## Impact

**Code**:
- `packages/runtime/src/queue-fs-lifecycle.ts` (537 lines) — deleted; replaced by `packages/runtime/src/queue-store.ts` (tenant-scoped accessor + lifecycle).
- `packages/runtime/src/queue-fs-lifecycle-crash.test.ts`, `packages/runtime/src/queue-fs-lifecycle.test.ts` — deleted; new tests cover row-lifecycle and tenant-scope.
- `packages/runtime/src/queue-plugin-config.ts` — config shape changes; validators and `queuesRoot` removed; only `declaredQueues` remains.
- `packages/sandbox-stdlib/src/queue/worker.ts` (555 lines) — collapses to a thin RPC proxy (~100 lines); validators removed, fs ops removed, host-call dispatch only.
- `packages/sandbox-stdlib/src/queue/queue.test.ts`, `queue-crash.test.ts` — rewritten against the bridge contract; crash test focuses on durability via DuckDB WAL rather than tmpfile+rename.
- `packages/runtime/src/ui/queue/queue-read.ts` (104 lines) — deleted; replaced by SQL via the tenant-scoped accessor.
- `packages/runtime/src/ui/queue/page.tsx` — items fragment switches to `EntryRow`; metadata header added.
- `packages/runtime/src/ui/invocations/page.tsx` — refactored to use new shared `EntryRow`.
- `packages/runtime/src/ui/shared/entry-row.tsx` (new) — shared expandable row component.
- `packages/runtime/src/ui/static/workflow-engine.css` — `.entry-summary--queue` and `.entry-summary--invocations` modifier classes; queue kind-color tokens.
- `packages/runtime/src/event-store.ts` — extends to inject the shared `DuckDBInstance` to the new `queue-store.ts`; no changes to event-store behavior.
- Bridge: new host-call ops `queue.put` and `queue.get`; existing event emission preserved (op + name only, no payload).

**Schema/data**:
- New `queue_items` table in `events.duckdb`. Hard cutover: existing NDJSON data is dropped (see `docs/upgrades.md`).

**Dependencies**: no new packages. DuckDB and Kysely are already in use by `event-store.ts`.

**Security**: tenant-scope enforcement strengthens from runtime check (event-store style) to compile-time signature + lint rule. Path-traversal class is eliminated by removing path construction from name. No new sandbox globals.

**Operator-facing**: `docs/upgrades.md` documents the hard cutover. No new env vars or config knobs.
