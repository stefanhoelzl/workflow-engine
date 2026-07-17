## Context

Per-workflow queues run on libSQL: one `queue_items` table keyed by the tenant tuple `(owner, repo, workflow, queue)`, popped FIFO by `MIN(seq)`. The guest surface is exactly `put(item) / get()`; a host bridge (`queue-host.ts` + `host-contract.ts`) marshals those calls over the worker→main channel, stamping producer metadata (`enqueuedAt`, `invocationId`, `triggerKind`, `triggerName`) at INSERT. Two invariants are load-bearing:

- **Tenant-scoped accessor** — every statement injects the full 4-tuple as `WHERE`; partial tuples do not compile; a Biome lint forbids raw `queue_items` access outside the accessor.
- **Workflow-wide depth cap** (1000 rows) bounds total storage, deliberately not per-queue, so a tampered guest inventing queue names cannot amplify storage.

`ws-send` needs to deliver a buffered message to a *specific* recipient. That is a partition-within-a-queue, which the single-stream model cannot express. This change adds a runtime `key` dimension. It builds on `add-migration-framework` (the `key` column reaches live databases via migration `0002`, not a wipe).

The `ws-send` addressing decision (who computes the key — the authenticated user vs a client-declared URL segment) is explicitly deferred to that later change. KeyedQueue is addressing-agnostic: it stores by an opaque string.

## Goals / Non-Goals

**Goals:**
- `put(item, key?)` / `get(key?)` on the existing `Queue<T>`; keyed and unkeyed coexist on one queue.
- Per-`(queue, key)` FIFO and at-most-once: a consumer of one key never observes or removes another key's items.
- Lossless rollout onto the live managed database (existing rows become the `''` partition).
- Keep the two load-bearing invariants (tenant isolation, workflow-wide cap) exactly as strong.

**Non-Goals:**
- Deciding the `ws-send` key source (deferred).
- A separate `KeyedQueue` type / brand / factory (rejected — see D1).
- Per-key drill-down in the `/queue` UI (deferred — see D5).
- A per-key depth cap (the workflow-wide cap already bounds storage).
- Any manifest change or queue-name-format change.
- Schema-validating the key (it is addressing, not payload — see D4).

## Decisions

### D1 — One `Queue<T>` with an optional key, not a separate `KeyedQueue`

Extend the existing handle: `put(item: T, key?: string)` / `get(key?: string)`. Unkeyed usage is the `''` partition; every existing workflow keeps working unchanged, and existing rows read as `''` after the migration.

*Alternative considered:* a distinct `defineKeyedQueue` primitive with `put(key, item)` / `get(key)`, its own brand, manifest entry, and build wiring. Rejected — it duplicates the SDK / manifest / host-contract / UI surface for a difference that is one column, and forces key-first argument order that is incompatible with keeping `put(item)` working. The unified handle collapses "unkeyed" and "keyed" into a single concept: `''` is just one partition among many.

*Accepted cost:* nothing at the type level stops a queue being used keyed in one place and unkeyed in another. This matches the runtime, non-declared nature of keys and is acceptable; the SDK cannot know at authoring time which partitions will exist.

### D2 — `key` is a partition selector beside the tenant tuple, never inside it

`QueueScope` stays the tenant identity 4-tuple. `key` is a separate argument on the partition-scoped operations. The accessor therefore has two planes:

- **Tenant-isolation plane** — the 4-tuple is injected as `WHERE` on *every* statement (the invariant the accessor spec protects; unchanged).
- **Partition plane** — `key` is injected only on `put` (INSERT value), `get` (WHERE + `MIN(seq)` subquery), and returned by `list`. The queue-level GC operations — `reconcile`, `removeDeclaration`, `count`, `workflowDepth` — stay **key-blind**.

*Alternative considered:* fold `key` into `QueueScope`, making it a 5-tuple. Rejected — `reconcile` does `SELECT DISTINCT (owner,repo,workflow,queue)` and `removeDeclaration` deletes the whole queue; a 5-tuple scope would drag `key` into those GC statements, forcing per-key special-casing to restore "GC the whole queue." Keeping `key` out of scope means both GC paths are literally untouched: `DISTINCT` collapses keys, keep-or-drop is per queue.

This asymmetry — tuple on every statement, key on partition ops only — *is* the design. It is why re-upload cleanup and boot reconciliation need no changes.

### D3 — The `''` default is materialized once, in the SDK guest shim

The optionality (`key?`) and its `''` default live only in the guest `Queue<T>` shim. By the time a call crosses the wire, `key` is a concrete `string`; the host-contract schema is `key: z.string()` (required), and the store signature is `get(scope, key: string)` — no optionality below the SDK line.

*Rationale:* the codebase is deliberate about single-point-of-truth defaults (e.g. `z.stringbool` over coerce-boolean, host as the sole policy authority). Defaulting in one place removes the "did every layer remember to default it?" bug class. `''` is a valid explicit key: `put(item, '')` ≡ `put(item)`.

### D4 — Key is addressing, not provenance or payload; it is not schema-validated

The per-queue Zod schema validates the *item*, not the key. The key is a routing label chosen by the caller (and, in `ws-send`, derived from identity or URL). It sits next to the provenance fields in storage and in the UI row, but it means "who this item is *for*," not "who produced it." Length is bounded (D6); content is opaque.

### D5 — `/queue` UI shows a per-row `key=` badge; no drill-down

The item fragment gains one column: each row renders its `key=` (empty key shown as `—` or omitted). The card list stays manifest-driven and the item route (`items?offset=N`) is unchanged; keys interleave in the one FIFO list.

*Alternative considered:* per-key drill-down (card → per-key sub-cards with counts, `items?key=…&offset=N`). Rejected for this change — it introduces the first *runtime-discovered* level into a UI whose entire routing/auth model assumes *manifest-declared* entities (`:queue` resolves against the manifest; a `:key` cannot), and needs a new `listKeys` store method, adaptive `''`-collapsing, and sub-card ordering rules. The workflow-wide 1000-row cap makes a many-keys-each-many-items queue unlikely, so the drill-down's value is small relative to its surface. Revisit if a real workload justifies it.

### D6 — Key length cap = 128 UTF-8 bytes, enforced host-side, `queue.keyTooLarge`

The key is validated in the queue host handler before `put`/`get` touch the store: `Buffer.byteLength(key,'utf8') > 128` throws a new `queue.keyTooLarge` `QueueError`, which crosses the worker→main→worker boundary like the existing queue errors. Independent of the 1024-byte item cap so a long key cannot shrink item budget. 128 bytes comfortably holds GitHub logins (with hyphens), UUIDs, and session ids — the realistic `ws-send` key sources.

*Why not reuse `QUEUE_NAME_RE`* (`^[a-z][a-zA-Z0-9]*$`)? It forbids hyphens, which would reject `stefan-hoelzl` and any UUID — foreclosing the identity-addressing option before `ws-send` chooses it. The key needs no regex: it is a column value, never a path (the same reasoning `queue-host.ts` already applies to queue names), so there is no traversal risk; only the length bound is required.

### D7 — Storage: `ALTER TABLE ADD COLUMN` via migration 0002; new composite index

`0002_queue_key.up`: `ALTER TABLE queue_items ADD COLUMN key TEXT NOT NULL DEFAULT ''` (SQLite/libSQL permits this because the default is non-null; existing rows are stamped `''`), then `CREATE INDEX IF NOT EXISTS queue_items_tuple_key_seq_idx ON queue_items (owner, repo, workflow, queue, key, seq)`. Empty string, never NULL — `get()`→`get('')` needs `key = ''` to match (`key = NULL` is never true in SQL). The prior `(…, queue, seq)` index may be dropped or left; at 1000 rows it is immaterial, so leave it to keep the migration minimal.

## Risks / Trade-offs

- **A keyed `put` and unkeyed `get()` on the same queue silently miss each other** → `put(item, "alice")` then `get()` returns `undefined` (different partition), which can look like data loss to an author. Mitigation: document the partition model in the SDK spec and demo; `get()` ≡ `get('')` is stated explicitly. This is inherent to partitioning, not a defect.

- **`''` sentinel coupling** → the unkeyed partition is the empty string, used both as the column default and the `get()` no-arg target. If any layer sent `NULL` instead of `''`, equality predicates would silently never match. Mitigation: `NOT NULL DEFAULT ''` on the column and a required `z.string()` on the wire make `NULL` unrepresentable end-to-end.

- **Key crosses the sandbox boundary as a new wire argument** → a tampered guest could send an arbitrary key. But the key is host-validated for length, is a column value (not a path), and is confined to the guest's own tenant partition (the 4-tuple is host-stamped). Total storage stays bounded by the workflow-wide cap regardless of key cardinality. No new confidentiality or storage-amplification surface. Mitigation: length check in the host handler; no other gate needed (consistent with the existing "no runtime queue-name gate" reasoning).

- **Depends on `add-migration-framework`** → `0002` cannot exist without the runner + provider. Mitigation: sequence the merges; the proposal states the dependency; if the framework is not yet merged, this change is blocked at the migration step, which is visible immediately.

## Migration Plan

1. Land after `add-migration-framework`. Add `0002_queue_key.ts` and register it in the provider.
2. Thread `key` through store (`put`/`get`/`RowWithMeta`), host-contract, worker, guest shim, and SDK `Queue<T>`; add the host-side length check + `queue.keyTooLarge`.
3. Add the `/queue` row badge; update `demo.ts`.
4. Deploy. On boot the runner applies `0002` (lossless `ALTER`); existing rows become the `''` partition; unkeyed workflows behave identically. No operator step, no tenant rebuild.
5. **Rollback:** revert the deploying tag and redeploy. The `key` column is inert to the reverted binary (it has a `DEFAULT ''`, and old inserts omit it → `''`); no data is lost. `docs/upgrades.md` records the change as additive.
