## Context

The sandbox bridge between QuickJS (guest) and Node.js (host) logs every call as a `LogEntry` — method name, args, result, timing. These logs are collected in an array during execution, returned in `RunResult.logs`, and immediately discarded by `buildInvokeHandler` in `workflow-registry.ts`. The runtime only persists three coarse lifecycle events (`started`/`completed`/`failed`) via the event bus, losing all execution detail.

The current event model uses a mutable state machine (`pending` → `processing` → `done`) with updates to a DuckDB `invocations` table. An older design (pre-commit `8b71490`) had a flat `events` table with one row per `RuntimeEvent`, but the recent refactor replaced it with the summary table.

This design introduces a paired request/response event model that captures every interaction at full fidelity, streams events in real time, and persists them in an append-only flat table.

## Goals / Non-Goals

**Goals:**

- Capture every sandbox-host interaction as a persistent, queryable event
- Enable flame graph reconstruction from event ordering alone
- Stream events in real time (persist-as-you-go, survive crashes)
- Decouple action dispatch logic from the SDK (SDK becomes pure definitions)
- Establish a clean dispatch contract in `core` shared between SDK and runtime

**Non-Goals:**

- Dashboard flame graph UI (future work — this change provides the data model only)
- Real-time event streaming to external consumers (WebSocket, SSE)
- Event retention policies or cleanup
- Backward compatibility with existing archive files (no production data yet)

## Decisions

### D1: Paired request/response events over single-entry logs

Every interaction produces two events: a `*.request` before execution and a `*.response` or `*.error` after. This replaces the single `LogEntry` that combined both phases.

**Why:** Paired events let you see in-flight operations (request emitted, response not yet), compute duration from timestamp differences, and reconstruct nesting from event ordering. A single combined entry can only be written after completion, losing crash-time state and making nesting reconstruction ambiguous.

**Alternative:** Keep single entries with a `parentSeq` field. Rejected because it requires the entry to exist before children can reference it, which conflicts with streaming (the entry isn't complete until the call finishes).

### D2: `ref` field over depth or parent pointers

Each event carries a `ref` field pointing to a related `seq`:
- `*.request` → `ref` = seq of the calling request (null for `trigger.request`)
- `*.response` / `*.error` → `ref` = seq of the matching `*.request`

Computed via a `refStack` in the bridge: on `*.request`, `ref = stack.top`, then push; on `*.response`/`*.error`, `ref = stack.pop()`.

**Why:** `ref` enables both "what called this?" (ref on a request) and "what's the matching response?" (ref on a response) as single-field lookups. A `depth` field only gives nesting level, not the specific parent or matching pair. A `parentId` field requires a separate ID system.

**Alternative:** `depth` field — simpler but doesn't identify the specific parent request or match responses to requests without scanning.

### D3: Flat `events` table over invocations summary table

One DuckDB table, one row per event, append-only. No updates. Invocation status is derived via a join (`trigger.request` LEFT JOIN terminal event).

**Why:** Append-only is simpler, faster for writes, and matches the event-sourcing model. The old `invocations` table required upserts (insert on started, update on completed/failed) which added complexity. The summary view is a trivial query.

**Alternative:** Keep the `invocations` table alongside an `events` detail table. Rejected as redundant — the events table contains all the information.

### D4: Dispatch contract in `core`, implementation in runtime

`core` exports `ActionDispatcher` type and `dispatchAction()` accessor (reads `globalThis.__dispatchAction`). The SDK's `action()` callable calls `dispatchAction(name, input, handler, outputSchema)`. The runtime installs `globalThis.__dispatchAction` as appended JS source in `buildSandboxSource`.

**Why:** Separates concerns cleanly across the dependency graph. The SDK defines actions (schemas + handler). Core defines the dispatch contract. The runtime provides the implementation (validation + event emission + handler invocation + output parsing). The SDK never knows about `__hostCallAction`, `__emitEvent`, or event types.

**Alternative:** Keep dispatch logic in SDK, add `__emitEvent` calls there. Rejected because it couples the SDK to runtime machinery and makes the SDK untestable without a sandbox.

### D5: No `TriggerDispatcher` in core

Trigger event wrapping (`trigger.request`/`trigger.response`/`trigger.error`) is handled by the worker's `handleRun()`, not by a dispatcher in core.

**Why:** No in-sandbox code ever calls `dispatchTrigger`. Triggers are only invoked by the worker's `handleRun()`, which already wraps the export call. Adding a `TriggerDispatcher` would create unused infrastructure. Actions need the dispatcher pattern because action-calls-action happens inside the sandbox via the SDK callable.

### D6: `__emitEvent` as `vm.newFunction`, not `bridge.sync()`/`bridge.async()`

The `__emitEvent` global is installed directly via `vm.newFunction` in the worker, bypassing the bridge's `sync()`/`async()` wrappers.

**Why:** If `__emitEvent` went through `bridge.sync()`, it would generate its own `system.request`/`system.response` events for every action event emission — recursive noise. By installing it outside the bridge, it's invisible in the event stream.

**Security justification (SECURITY.md §2):** `__emitEvent` does not expose Node.js APIs, host objects, or process-level capabilities. It accepts a constrained JSON payload (only `action.*` kinds) and posts it as a message to the worker's parent port. The guest cannot use it to read host state, execute host code, or escape the sandbox. It is a write-only data channel for structured telemetry.

### D7: `__dispatchAction` as appended JS source, not a bridge global

The action dispatcher implementation is appended as plain JavaScript to the sandbox source (like the existing trigger shim and action name binder), not installed as a `vm.newFunction`.

**Why:** The dispatcher calls `__hostCallAction` (bridge RPC), `__emitEvent` (bridge global), `handler()` (user code), and `outputSchema.parse()` (Zod). All of these are available as globals inside QuickJS. Writing it as JS keeps the logic visible in the source, testable, and avoids complex handle marshaling for the handler/schema closures.

### D8: Events stream via `onEvent` callback, not buffered in `RunResult`

The sandbox exposes `sb.onEvent(cb)`. The worker posts `{ type: "event", event }` messages to the main thread, which calls the callback immediately. `RunResult` carries only `{ ok, result }` or `{ ok, error }` — no logs, no events.

**Why:** Streaming means events are persisted as they happen. If the process crashes mid-invocation, all events up to that point are already in the store and on disk. Buffering would lose everything on crash.

### D9: One file per event in persistence, archive on terminal event

Each event is written as `{id}_{seq}.json` in `pending/`. When a terminal event (`trigger.response` or `trigger.error`) arrives, all files for that invocation are moved to `archive/{id}/`.

**Why:** One-file-per-event with immediate writes gives crash resilience. The archive move is atomic per invocation — all events for a completed invocation end up together. Recovery scans `pending/` for orphaned events from crashed invocations.

**Alternative:** One file per invocation, appended to. Rejected because append is not atomic on all storage backends (S3 doesn't support append), and a partial file is harder to recover from than N complete event files.

### D10: Bridge method naming convention

Bridge methods get human-readable prefixed names for the event stream:

| Global name | Event `name` field |
|---|---|
| `__hostCallAction` | `host.validateAction` |
| `__hostFetch` / `xhr.send` | `host.fetch` |
| `console.log` | `console.log` |
| `crypto.subtle.digest` | `crypto.subtle.digest` |
| `setTimeout` | `timers.setTimeout` |

**Why:** The `name` field in events should be readable by humans inspecting the trace. `host.*` prefix distinguishes calls that cross the worker thread boundary (RPC to main thread) from calls handled within the worker.

### D11: `workflowSha` computed at build time

The vite plugin computes `SHA-256(bundleSource)` during `generateBundle` and includes it in the manifest as `sha`. Every event row carries `workflowSha`.

**Why:** Events must be self-contained for traceability. Knowing which exact bundle version produced an event is essential for debugging. Computing at build time is deterministic and costs nothing at runtime.

## Risks / Trade-offs

**[Event volume]** Every bridge call generates 2 rows. A handler making 50 fetch calls produces ~106 events (trigger pair + 50 system pairs + action pairs + validation pairs). For DuckDB in-memory this is fine; for file persistence, 106 small files per invocation is manageable but worth monitoring.
→ Mitigation: Monitor file counts. If needed, batch event file writes (buffer N events into one file) — but defer until evidence shows it's needed.

**[`__emitEvent` security surface]** Adding a new global to the sandbox requires SECURITY.md update and security-boundary tests.
→ Mitigation: Constrain accepted event kinds to `action.*` only (reject `trigger.*`, `system.*`). Validate payload shape. The global is write-only (guest → host), cannot read host state.

**[Dashboard query performance]** The invocation summary is now a join instead of a direct table scan. For the current scale (in-memory DuckDB, hundreds of invocations) this is negligible.
→ Mitigation: If needed, create a DuckDB view for the summary query.

**[Backward incompatibility]** Archive format changes completely. Existing archived invocation files cannot be loaded.
→ Mitigation: Acceptable — no production data exists yet. Document in migration notes.

**[refStack correctness under async interleaving]** QuickJS is single-threaded and the worker's RPC loop serializes bridge calls (`receiveMessageOnPort` blocks). `Promise.all` does not parallelize bridge calls. The refStack stays consistent.
→ Mitigation: If the worker model ever changes to allow concurrent bridge calls, the refStack design must be revisited. Add a test that verifies `Promise.all([fetch(a), fetch(b)])` produces correctly nested events.
