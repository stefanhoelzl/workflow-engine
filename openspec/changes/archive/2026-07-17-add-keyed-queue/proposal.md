## Why

Per-workflow queues today address a single FIFO stream per `(owner, repo, workflow, queueName)`. The upcoming `ws-send` capability needs to buffer a message for a *specific* recipient — a WebSocket connection that may not be established yet — and deliver it only to that recipient when it (re)connects. That requires a partition dimension the queue does not have: a runtime **key** that names a mailbox *within* a queue, so `put(item, key)` and `get(key)` address one partition without a consumer draining another's items. This change adds that key dimension to the queue primitive; `ws-send` is its first consumer (and decides how the key is computed).

## What Changes

- Add an optional **`key`** to the queue primitive. The guest-facing `Queue<T>` handle becomes `put(item, key?)` / `get(key?)`; an omitted key resolves to the unkeyed partition. `get(key)` pops FIFO **within that key only**; `get()` ≡ `get('')` and pops only unkeyed items. A consumer of one key never sees another key's items.
- Represent the key as a `key TEXT NOT NULL DEFAULT ''` column on `queue_items`, added via migration **`0002_queue_key`** (lossless `ALTER TABLE ADD COLUMN`; existing rows become the `''` unkeyed partition). New composite index `(owner, repo, workflow, queue, key, seq)`.
- **The `''` default is materialized in exactly one place — the SDK guest shim.** Below the SDK line, `key` is a required explicit `string` on the wire and in the store; no optionality propagates into the host.
- **Key is a partition selector beside the tenant tuple, never inside it.** Only the partition-scoped accessor operations (`put`, `get`, and the `key` value returned by `list`) are key-aware; the queue-level GC operations (`reconcile`, `removeDeclaration`, `count`, `workflowDepth`) stay key-blind, so re-upload cleanup and boot reconciliation are untouched.
- Validate the key host-side: length ≤ **128 UTF-8 bytes**, rejected as a new typed `queue.keyTooLarge` error. Independent of the 1024-byte item cap. The workflow-wide depth cap (1000 rows) continues to bound total storage regardless of how many keys exist, so invented keys cannot amplify storage.
- Surface the key in the `/queue` inspection UI as a per-row `key=` badge in the existing item fragment (flat list, manifest-driven — no per-key drill-down, no new route). Key is rendered as *addressing*, distinct from the producer-provenance fields (`invocationId`, `triggerKind`, `triggerName`, `enqueuedAt`).
- Update `workflows/src/demo.ts` to exercise a keyed `put`/`get` (SDK-surface-change rule).
- **No manifest change** (keyed-ness is a per-row runtime property, not a queue-level declaration) — no tenant rebuild required.

## Capabilities

### New Capabilities

_None._ This change extends existing capabilities; it introduces no new coherent module.

### Modified Capabilities

- `queues`: the queue gains a `key` partition dimension — FIFO and at-most-once become per-`(queue, key)`; the guest `Queue<T>` contract gains the optional key; the tenant-scoped accessor gains the key as a partition selector on partition-scoped ops only; the `queue_items` storage layout gains the `key` column; a new key size cap and `queue.keyTooLarge` error.
- `sdk`: `defineQueue` returns a handle whose members become `put(item, key?)` / `get(key?)`.
- `queues-ui`: the item fragment row gains a `key=` badge alongside the existing provenance metadata.

## Impact

- **Depends on `add-migration-framework`** — must merge after it; ships migration `0002_queue_key` as a new entry in the static migration provider.
- **New:** `packages/runtime/src/migrations/0002_queue_key.ts` (the `ALTER TABLE ADD COLUMN key` + new index), registered in `migrations/index.ts`.
- **Modified:** `packages/runtime/src/queue-store.ts` — `put`/`get` gain a `key: string` parameter; `RowWithMeta`/`PoppedRow` gain `key`; `list` returns `key`; new index; new `queue.keyTooLarge` (host-side length check lives in the queue host handler). `count`, `workflowDepth`, `reconcile`, `removeDeclaration` unchanged.
- **Modified:** `packages/sandbox-stdlib/src/queue/host-contract.ts` — `queuePutArgs` / `queueGetArgs` gain `key: z.string()`; `packages/sandbox-stdlib/src/queue/worker.ts` and `index.ts` (guest shim) forward the key with the `''` default.
- **Modified:** `packages/sdk/src/index.ts` — `Queue<T>` interface + `defineQueue` closure add the optional key param.
- **Modified:** `packages/runtime/src/ui/queue/page.tsx` — item row renders the `key=` badge.
- **Modified:** `workflows/src/demo.ts` — keyed put/get example.
- **Modified:** `docs/upgrades.md` — additive, no tenant rebuild; migration `0002` is lossless (existing rows → `''` partition).
- **Not changed:** manifest schema, `QUEUE_NAME_RE` / core regexes, EventBus pipeline, sandbox globals surface.
