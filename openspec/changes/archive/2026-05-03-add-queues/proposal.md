## Why

Workflow authors today have no first-class way to persist small pieces of data between invocations of the same workflow. The runtime serializes invocations per workflow, EventStore archives lifecycle events, and `StorageBackend` is engine-internal — none of these surface to author code. Authors who want a producer trigger to hand work to a separate consumer trigger (e.g., a webhook enqueues, a cron drains) have no engine-supported primitive and must externalize the state to an external service via the `sql` plugin or `fetch`. A small, durable, FIFO data structure scoped to a single workflow closes that gap.

## What Changes

- **Add** a `defineQueue({name?, schema})` SDK primitive returning a brand-tagged `{put, get}` handle. Required-exported, brand-discovered like every other primitive. The queue's `name` defaults to the export identifier (matching action and trigger name-derivation); an explicit `name` overrides. Many queues per workflow, names unique within file, camelCase regex shared with actions.
- **Add** a host-bridge `queue` plugin under `packages/sandbox-stdlib/src/queue/` that surfaces `__queue` (locked outer + frozen inner `{put, get}`), backed by a private `$queue/do` descriptor phase-3-deleted from guest scope. Plugin worker performs NDJSON I/O against runtime-injected per-sandbox config.
- **Add** queue file persistence at `<root>/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson` — one JSON-encoded item per line, hand-rolled (no new deps).
- **Add** durability contract: `put` opens-appends-fsyncs-closes; `get` reads-rewrites-fsyncs-renames-fsyncs(parent dir). Successful `put`/`get` returns guarantee the on-disk effect survives SIGKILL / power loss. This is the only engine primitive making such a guarantee.
- **Add** semantic invariants: FIFO by enqueue time; at-most-once pop on `get`; schema validated on both `put` and `get`; `get`-time validation failure drops the bad item and surfaces it inside a typed `QueueSchemaMismatch` error payload (no poison queue, no dead-letter); caps `1 KB` per item and `1k` items per queue (`QueueItemTooLarge`, `QueueFull`); `QueueGone` when an orphaned in-flight invocation hits a queue whose file was unlinked by a concurrent upload.
- **Add** lifecycle: queue identity is `(owner, repo, workflow, queueName)`. Persists across re-uploads (sha not in identity). On upload, the workflow registry atomically diffs declared queues — added queues get an empty file created (eager: `file exists ⇔ queue declared`), removed queues get their file unlinked. Workflow deletion drops the entire workflow's queue subtree. Boot reconciliation sweep handles orphans / missing files left by SIGKILL between manifest persist and filesystem ops.
- **Modify** `WorkflowManifest` to carry `queues: [{name, schema: <JSON Schema>}]` derived at build time via the existing `z.toJSONSchema()` pass that runs for actions.
- **Modify** the workflow build pipeline to discover `defineQueue` exports by brand, derive `name` from the export identifier when the factory was called without a `name` (same rule as `action` and `*Trigger`), and emit a build error on duplicate `name` within the same workflow file or non-export of the handle. Schemas not representable in JSON Schema (`z.void()`, `z.undefined()`) are rejected at build time, same exclusion as action output.
- **Modify** the runtime sandbox composition (`sandbox-store.ts`) to add the `queue` plugin to the production catalog with a runtime-built config carrying frozen `(owner, repo, workflow, queuesRoot, declaredQueues, validators)` — validators are Ajv functions compiled host-side from the manifest's queue schemas at sandbox construction, mirroring the `host-call-action` pattern.
- **Modify** `invocations` to accept new `system.*` event `name` values `"queue.put"` and `"queue.get"`. No new event prefix; rides the existing reserved `system.*` family per `SECURITY.md` §2 R-7. Bounded volume: ≤ ~2k events per drain given the 1k-item cap.
- **Modify** `SECURITY.md` with a new isolation-invariants row, a new globals-surface entry for `__queue`, threats T-Q1..T-Q4 (path traversal, symlink, storage DoS, TOCTOU), and the matching mitigations (build-time + bridge-time queue-name regex, `O_NOFOLLOW`, bounded caps, UUID-suffixed tmpfiles). Updates the "Adding a system-bridge plugin" enumeration to include `queue`. **No new R-rule** is introduced; the queue plugin complies with R-1, R-2, R-4, R-5, R-7, R-13, R-14 as written.
- **Update** `workflows/src/demo.ts` to showcase `defineQueue` + `put`/`get` per the CLAUDE.md "SDK surface change must update demo.ts" rule.

Out of scope (deferred): visibility timeout / ack / dead-letter (ruled out by the at-most-once choice), cross-workflow / cross-tenant queues, push/trigger-on-enqueue, peek/clear/size inspection ops, dynamic queue creation, schema-fingerprint upload gates, per-queue cap overrides.

## Capabilities

### New Capabilities

- `queues`: Author-facing FIFO data structure scoped to one workflow. Owns the storage layout, durability contract, schema-validation policy, cap enforcement, atomic-with-upload lifecycle, and the per-sandbox plugin config shape.

### Modified Capabilities

- `sdk`: adds the `defineQueue` factory, `QUEUE_BRAND`, `isQueue` type guard, and re-exports of the `Queue` typed handle interface.
- `workflow-build`: adds brand-based discovery of queue exports, JSON Schema derivation, and build-time validation (export required, unique names, JSON-Schema-representable schema).
- `workflow-manifest`: adds the `queues: [{name, schema}]` field on `WorkflowManifest`.
- `workflow-registry`: adds the upload-tx filesystem side-effects (eager file create for added queues, unlink for removed queues) and the boot reconciliation sweep that ensures `file exists ⇔ queue declared` is the persistent invariant.
- `sandbox-stdlib`: adds the `queue` plugin (worker-side NDJSON I/O, guest-side `__queue` IIFE) parallel to `sql` and `mail`.
- `sandbox-plugin`: adds the `queue` plugin to the production catalog composition in `sandbox-store.ts` with its config-injection contract.
- `invocations`: adds `system.request` / `system.response` / `system.error` with `name="queue.put"` and `name="queue.get"` to the event-name inventory and lists the new typed error codes (`queue.itemTooLarge`, `queue.full`, `queue.schemaMismatch`, `queue.gone`, `queue.notDeclared`).
- `persistence`: adds the `<root>/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson` layout to the on-disk persistence contract.

## Impact

- **Code**:
  - New files: `packages/sandbox-stdlib/src/queue/{index.ts,worker.ts,types.ts,descriptor-name.ts,queue-error.ts,queue.test.ts}`, `packages/runtime/src/queue-plugin-config.ts` (runtime composer's queue config builder), `packages/runtime/src/workflow-registry-queue-fs.ts` (or inline) for the upload-tx fs ops + boot sweep.
  - Modified: `packages/sdk/src/index.ts` (factory, brand, type guard), `packages/sdk/src/plugin/*` (vite-plugin discovery), `packages/core/src/index.ts` (`ManifestSchema` adds `queues` field; new error codes if surfaced through `InvocationEventError`), `packages/runtime/src/sandbox-store.ts` (compose plugin), `packages/runtime/src/workflow-registry.ts` (atomic upload-tx filesystem side-effects, boot sweep), `workflows/src/demo.ts` (showcase).
- **APIs**: New author-facing `defineQueue` and the typed `Queue<T>` handle. New manifest field (forward-compatible: existing manifests without `queues` parse as empty). New `system.*` `name` values (additive).
- **Dependencies**: None added. Hand-rolled NDJSON via `node:fs/promises`.
- **Persistence**: New on-disk subtree under `PERSISTENCE_PATH/queues/`. Existing deployments without queues are unaffected; the boot sweep tolerates a missing root directory.
- **Security**: New `__queue` guest-visible global; new threat surface T-Q1..T-Q4 mitigated as detailed in the SECURITY.md updates. No relaxation of any existing invariant.
- **Operations**: Operators gain a per-workflow on-disk view of queue state (each queue is one inspectable file). Backup story: include `<root>/queues/` alongside the existing `<root>/workflows/` and `<root>/events/` trees.
- **Upgrades**: Tenants do NOT need to rebuild or re-upload to consume the change; queues are opt-in per workflow. Adding `defineQueue` to a workflow that has already been deployed requires a re-upload (standard for any SDK-surface use).
