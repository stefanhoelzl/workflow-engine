## 1. Migration (depends on add-migration-framework)

- [x] 1.1 Create `packages/runtime/src/migrations/0002-queue-key.ts` with an `up(db)` that runs `ALTER TABLE queue_items ADD COLUMN key TEXT NOT NULL DEFAULT ''`, `CREATE INDEX IF NOT EXISTS queue_items_tuple_key_seq_idx ON queue_items (owner, repo, workflow, queue, key, seq)`, and `DROP INDEX IF EXISTS queue_items_tuple_seq_idx` (so fresh + migrated DBs end with an identical index set). No `down`.
- [x] 1.2 Register `0002-queue-key` in `packages/runtime/src/migrations/index.ts` after `0001-initial`.
- [x] 1.3 **REVISED — do NOT edit 0001.** `0001-initial` was already shipped/committed; editing a shipped migration forks its meaning across DBs (and would make `0002`'s ALTER hit `duplicate column name` on fresh DBs). Instead the `key` column is added solely by `0002`'s unconditional ALTER — safe because `0001` never creates `key`, so it runs exactly once. Fresh DB (`0001`→`0002`) and existing DB both converge on the same schema (key column + key index only).

## 2. QueueStore: key-aware partition operations

- [x] 2.1 Add `key` to the `QueueItemsTable` interface and to `PoppedRow` / `RowWithMeta`.
- [x] 2.2 `put(scope, item, key: string, producer)`: include `key` in the INSERT values. Key is a required explicit string (no default here — the SDK shim defaults it).
- [x] 2.3 `get(scope, key: string)`: add `AND key = ?` to both the outer `WHERE` and the `MIN(seq)` subselect of the `DELETE … RETURNING`.
- [x] 2.4 `list(scope, offset, limit)`: select and return `key` on each `RowWithMeta` (still whole-queue, key-blind ordering by `seq`).
- [x] 2.5 Confirm `count`, `workflowDepth`, `removeDeclaration`, `reconcile` remain key-blind (no signature or SQL change).
- [x] 2.6 Remove/replace the old `queue_items_tuple_seq_idx` reference if the store still names it; the DDL now lives in migrations only (per add-migration-framework).

## 3. Key size cap + error

- [x] 3.1 Add `MAX_KEY_BYTES = 128` and a `"queue.keyTooLarge"` variant to `QueueErrorCode`.
- [x] 3.2 In the queue host handler (`queue-host.ts`), before `put`/`get` touch the store, reject `Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES` with `QueueError("queue.keyTooLarge", …)`.

## 4. Host bridge wire contract

- [x] 4.1 `host-contract.ts`: add `key: z.string()` to `queuePutArgsSchema` and `queueGetArgsSchema` (required string on the wire).
- [x] 4.2 `worker.ts` (`dispatchPut`/`dispatchGet`): forward the `key` argument through `ctx.callHost`.

## 5. Guest SDK surface

- [x] 5.1 `sandbox-stdlib/src/queue/index.ts` guest shim: `put(name, item, key)` / `get(name, key)` default an omitted `key` to `''` — the sole materialization point.
- [x] 5.2 `packages/sdk/src/index.ts`: `Queue<T>` interface → `put(item: T, key?: string)` / `get(key?: string)`; `defineQueue` closure forwards `key` to the dispatcher. Keep the handle frozen and the `QUEUE_BRAND`.

## 6. Queue UI

- [x] 6.1 `ui/queue/page.tsx`: render a `key` badge on each item `EntryRow`, sourced from the row's `key`; unkeyed rows (`key === ""`) render no badge (or a neutral `—`), visually distinct from the provenance identity segment.
- [x] 6.2 Ensure the items fragment query surfaces `key` (via the `list` change in 2.4); no new route or query param.

## 7. Demo + docs

- [x] 7.1 `workflows/src/demo.ts`: exercise a keyed `put`/`get` (e.g. an httpTrigger enqueues under a key, a consumer drains that key), keeping the every-trigger-exercises-`runDemo` invariant intact.
- [x] 7.2 `docs/upgrades.md`: additive entry — migration `0002_queue_key` is lossless (existing rows → `''` partition), no tenant rebuild, no manifest change; note the new `queue.keyTooLarge` error.

## 8. Tests

- [x] 8.1 QueueStore: per-key FIFO — `put(A,"x")`, `put(B,"y")`, `put(C,"x")`; `get("x")`→A, `get("y")`→B, `get("x")`→C.
- [x] 8.2 QueueStore: `get("bob")` on a queue with items only under `"alice"` returns `undefined` and leaves alice's items intact; `get()`≡`get("")`.
- [x] 8.3 QueueStore: key partition isolation fuzzed alongside the existing cross-tenant isolation test (get/put never cross keys).
- [x] 8.4 QueueStore: GC key-blindness — `removeDeclaration`/`reconcile` delete all keys; `count`/`workflowDepth` include all keys.
- [x] 8.5 Host handler: key at 128 bytes accepted, 129 bytes → `queue.keyTooLarge`, no row written; a 1024-byte item with a 100-byte key still accepted (key not counted against item cap).
- [x] 8.6 Migration: apply `0002` against a DB seeded with pre-migration `queue_items` rows; assert the `key` column and composite index exist and pre-existing rows read `key = ''` with all rows retained (crash/upgrade recovery: lossless ALTER).
- [x] 8.7 SDK/guest: `defineQueue` handle exposes `put(item, key?)`/`get(key?)`; omitted key crosses the wire as `""`; handle still frozen.
- [x] 8.8 Queue UI: keyed row renders the key badge, unkeyed row does not; rows interleave by `seq`; fragment stays read-only.

## 9. Verify

- [x] 9.1 `pnpm validate` passes (lint incl. the raw-`queue_items` accessor rule, check, test).
- [x] 9.2 `pnpm dev --random-port --kill` (backgrounded): grep `[READY]`; via the demo's keyed trigger, `put` an item under a key, confirm the `.persistence/` libSQL `queue_items` row carries that `key`, and `/queue` shows the key badge for it.
- [x] 9.3 Confirm an unkeyed `put`/`get` on the same queue still round-trips (the `''` partition), proving backward compatibility.
- [x] 9.4 `pnpm test:e2e` — SDK CLI upload + persistence layout touched; confirm keyed and unkeyed queue round-trips end to end. **Result:** `22-queue-roundtrip` passes in isolation against the `0002`-migrated schema (4.4s). The **keyed round-trip was proven end-to-end against the real `pnpm dev` runtime** (9.2/9.3): POST `enqueueJob` with `key:"alice"` (×2) + unkeyed → DB rows carry `key='alice'`/`''` correctly; `drainOnce {key:"alice"}` → `[a, c]` (FIFO within key, skipping unkeyed), `drainOnce {}` → `[b]`, `drainOnce {key:"alice"}` again → `[]`. Full-suite browser tests (chromium missing) and sandbox-eviction tests (time out on baseline) are the same pre-existing/environmental failures documented in `add-migration-framework`, unrelated to this change.
