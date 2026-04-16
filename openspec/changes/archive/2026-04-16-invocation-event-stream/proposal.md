## Why

Every bridge call between the QuickJS sandbox and the host (action invocations, fetch, crypto, console) is currently captured as a flat `LogEntry` array that gets discarded after each run. The runtime only persists coarse invocation lifecycle events (started/completed/failed), losing all detail about what happened during execution. This makes debugging, auditing, and performance analysis impossible — you know *that* an invocation ran, but not *what* it did.

## What Changes

- **Paired request/response event model**: Every interaction (trigger, action, system call) becomes two events — a `*.request` before and a `*.response` or `*.error` after. Nesting is captured via a `ref` field pointing to the parent request's sequence number, enabling flame graph reconstruction from flat event ordering.
- **Streaming event emission**: Events stream from the sandbox worker to the host via `onEvent` callbacks as they happen, instead of being buffered in `RunResult`. Events are persisted immediately, surviving mid-invocation crashes.
- **Flat `events` table**: Replace the `invocations` summary table (DuckDB) with an append-only `events` table — one row per event, no updates, no state machine.
- **Dispatch contract in `core`**: Move action dispatch logic (host validation + handler invocation + output parsing) out of the SDK into a `dispatchAction()` accessor in `core`. The runtime installs the dispatcher implementation at sandbox load time. The SDK becomes a pure definition library.
- **`__emitEvent` bridge global**: A new `vm.newFunction` in the sandbox worker that the dispatcher calls to emit `action.*` events. Does not go through `bridge.sync()`/`bridge.async()`, so it does not appear in the event stream itself.
- **`workflowSha` on manifest**: The vite plugin computes a SHA-256 hash of the bundle source at build time and includes it in the manifest. Every event row carries `workflow` and `workflowSha` for self-contained traceability.
- **File-per-event persistence**: Each event is written as an individual JSON file in `pending/`. On terminal event (`trigger.response` or `trigger.error`), all files for the invocation are moved to `archive/{id}/`.
- **Bridge method naming convention**: Rename bridge methods to use prefixed names (`host.validateAction`, `host.fetch`, `timers.setTimeout`, etc.) for clarity in the event stream.
- **BREAKING**: `RunResult` loses its `logs` field. `LogEntry` type is removed. `StartedEvent`/`CompletedEvent`/`FailedEvent` lifecycle events are replaced by `trigger.*` events. `InvocationLifecycleEvent` union is removed. The `invocations` DuckDB table is replaced by `events`. `Sandbox.run()` signature changes to accept `RunOptions`. SDK's `action()` callable no longer contains dispatch logic.

## Capabilities

### New Capabilities

None. All new requirements merge into existing capabilities.

### Modified Capabilities

- `core-package`: Gains `InvocationEvent` type, `EventKind` type, `ActionDispatcher` type, and `dispatchAction()` accessor.
- `event-bus`: Bus interface changes from `InvocationLifecycleEvent` to `InvocationEvent`. Consumer interface simplified. Event type definition absorbs the paired request/response model and self-contained event contract.
- `event-store`: DuckDB schema changes from `invocations` table to flat `events` table. Insert-only, no updates. Query patterns change. Absorbs flame graph query requirement.
- `persistence`: File layout changes from one-file-per-invocation to one-file-per-event with archive-on-terminal-event.
- `recovery`: Recovery synthesizes a `trigger.error` event instead of a `FailedEvent`. Scans `pending/` for orphaned event files.
- `logging-consumer`: Adapts to new event types. Logs on `trigger.request`, `trigger.response`, `trigger.error` only.
- `sandbox`: Bridge emits paired `system.request`/`system.response` events instead of `LogEntry`. New `onEvent` callback, new `RunOptions` parameter, `RunResult` simplified. Absorbs `__emitEvent` global, `ref`/`refStack` computation, bridge method naming convention, trigger event emission from worker, and event protocol message.
- `sdk`: `action()` callable delegates to `core.dispatchAction()`. All dispatch logic removed.
- `executor`: No longer builds invocation lifecycle events. Generates `invocationId`, wires `onEvent`, delegates to `WorkflowRunner.invokeHandler` with id. `invocation.ts` removed.
- `workflow-registry`: Appends `__dispatchAction` implementation to sandbox source. `buildInvokeHandler` passes invocation metadata to `sb.run()`. Bridge methods renamed.
- `workflow-manifest`: `sha` field added to manifest schema (computed at build time).
- `workflow-build`: Vite plugin computes SHA-256 of bundle source, includes in manifest.

## Impact

- **Packages**: `core`, `sdk`, `sandbox`, `runtime` (all four packages change)
- **Database**: `invocations` table replaced by `events` table — all existing dashboard queries need rewriting
- **Persistence format**: Archive file layout changes — existing archives incompatible (acceptable, no production data yet)
- **Public API**: `Sandbox` interface changes (`onEvent`, `RunOptions`), `RunResult` simplified, `LogEntry` removed
- **Security boundary**: One new bridge global (`__emitEvent`) added to QuickJS sandbox — must be documented in SECURITY.md threat model
- **Build pipeline**: Vite plugin gains SHA computation step
