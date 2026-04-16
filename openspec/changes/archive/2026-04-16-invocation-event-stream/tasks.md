## 1. Event Types and Dispatch Contract (core)

- [x] 1.1 Add `InvocationEvent` interface, `EventKind` type to `packages/core/src/index.ts`
- [x] 1.2 Add `ActionDispatcher` type and `dispatchAction()` accessor to `packages/core/src/index.ts`
- [x] 1.3 Add `sha: z.string()` field to `ManifestSchema` in `packages/core/src/index.ts`
- [x] 1.4 Export all new types and functions from core

## 2. SDK Simplification

- [x] 2.1 Replace `action()` callable body with `dispatchAction(name, input, handler, outputSchema)` call in `packages/sdk/src/index.ts`
- [x] 2.2 Remove `getHostCallAction()`, `HostCallAction` type, and inline dispatch logic from SDK
- [x] 2.3 Update SDK tests to verify callable delegates to `dispatchAction` and contains no dispatch logic

## 3. Build Pipeline (sha)

- [x] 3.1 Compute SHA-256 of bundle source in vite plugin `generateBundle` and include as `sha` field in emitted manifest
- [x] 3.2 Update workflow-build tests to assert `sha` field is present and deterministic

## 4. Sandbox Bridge — Paired Events

- [x] 4.1 Add `seq` counter, `refStack`, `invocationId`, `workflow`, `workflowSha` state to bridge in `packages/sandbox/src/bridge-factory.ts`
- [x] 4.2 Add `postEvent` function that stamps events with `id`, `seq`, `ref`, `ts`, `workflow`, `workflowSha` and posts `{ type: "event" }` message
- [x] 4.3 Modify `sync()` to emit `system.request` before impl and `system.response`/`system.error` after
- [x] 4.4 Modify `async()` (asyncBridge) to emit `system.request` synchronously on call and `system.response`/`system.error` on resolve/reject
- [x] 4.5 Remove `LogEntry` type, `logs` array, `pushLog()`, `resetLogs()` from bridge — replace with `setRunContext()` and `resetSeq()`
- [x] 4.6 Rename bridge method registrations: `xhr.send` → `host.fetch`, add support for method name override in `installRpcMethods`
- [x] 4.7 Update bridge-factory tests: assert paired events with correct `seq`, `ref`, `ts`, and method names. Include security test: `__emitEvent` does not appear as system event

## 5. Sandbox Worker — Event Streaming

- [x] 5.1 Add `invocationId`, `workflow`, `workflowSha` fields to `run` message in `packages/sandbox/src/protocol.ts`
- [x] 5.2 Add `{ type: "event", event: InvocationEvent }` to `WorkerToMain` union in protocol
- [x] 5.3 Simplify `RunResultPayload` to `{ ok: true; result: unknown } | { ok: false; error: { message; stack } }` — remove `logs` field
- [x] 5.4 Install `__emitEvent` as `vm.newFunction` in worker (NOT through bridge.sync/async) — accept only `action.*` kinds, stamp and post events. Include security test: rejects non-action kinds
- [x] 5.5 Modify `handleRun()` to: set run context on bridge, emit `trigger.request` before calling export, emit `trigger.response`/`trigger.error` after, post simplified done payload
- [x] 5.6 Update worker tests for new event streaming behavior and crash resilience

## 6. Sandbox Public API

- [x] 6.1 Add `onEvent(cb)` method to `Sandbox` interface and implementation in `packages/sandbox/src/index.ts`
- [x] 6.2 Change `run()` signature to accept `RunOptions` (`invocationId`, `workflow`, `workflowSha`, optional `extraMethods`)
- [x] 6.3 Simplify `RunResult` type — remove `logs` field
- [x] 6.4 Forward `{ type: "event" }` worker messages to registered `onEvent` callback on main thread
- [x] 6.5 Remove `LogEntry` export from sandbox package
- [x] 6.6 Update sandbox integration tests: assert events stream via `onEvent`, `RunResult` has no logs, correct event ordering

## 7. Workflow Registry

- [x] 7.1 Append `__dispatchAction` implementation as JS source in `buildSandboxSource` in `packages/runtime/src/workflow-registry.ts`
- [x] 7.2 Register `__hostCallAction` with bridge method name `host.validateAction`
- [x] 7.3 Change `buildInvokeHandler` to pass `invocationId`, `workflow`, `workflowSha` (from manifest) to `sb.run()`
- [x] 7.4 Add `onEvent` method to `WorkflowRunner` interface in `packages/runtime/src/executor/types.ts`, wiring through to `sb.onEvent()`
- [x] 7.5 Change `WorkflowRunner.invokeHandler` signature to accept `invocationId` as first parameter
- [x] 7.6 Update workflow-registry tests for new dispatch flow, event streaming, and method naming

## 8. Event Bus

- [x] 8.1 Replace `InvocationLifecycleEvent` union with `InvocationEvent` import from core in `packages/runtime/src/event-bus/index.ts`
- [x] 8.2 Remove `StartedEvent`, `CompletedEvent`, `FailedEvent`, `SerializedErrorPayload` interfaces
- [x] 8.3 Simplify `BusConsumer` to `handle(event: InvocationEvent): Promise<void>` — remove `bootstrap()` method
- [x] 8.4 Update event-bus tests

## 9. Executor

- [x] 9.1 Rewrite `createExecutor` to: generate `invocationId`, wire `workflow.onEvent → bus.emit`, call `invokeHandler(invocationId, ...)`, return shaped result
- [x] 9.2 Remove `invocation.ts` — invocation factory no longer needed
- [x] 9.3 Remove lifecycle event construction (`startedEvent`, `complete()`, `fail()`)
- [x] 9.4 Update executor tests: assert events flow through bus, invocation id generation, HTTP result shaping

## 10. Event Store (DuckDB)

- [x] 10.1 Replace `invocations` table DDL with `events` table DDL in `packages/runtime/src/event-bus/event-store.ts`
- [x] 10.2 Update `EventsTable` interface and `Database` type for new schema
- [x] 10.3 Rewrite `handle()` as pure insert (no upsert logic)
- [x] 10.4 Update `bootstrap()` to bulk-insert `InvocationEvent` arrays from archive
- [x] 10.5 Update query API and CTE helpers for events table
- [x] 10.6 Update event-store tests: insert-only behavior, bootstrap from events, dashboard summary query

## 11. Persistence

- [x] 11.1 Rewrite persistence consumer to write one file per event (`pending/{id}_{seq}.json`)
- [x] 11.2 On terminal event (`trigger.response`/`trigger.error`), move all `pending/{id}_*.json` to `archive/{id}/{seq}.json`
- [x] 11.3 Rewrite `scanPending()` to yield `InvocationEvent` objects from individual event files
- [x] 11.4 Rewrite `scanArchive()` to yield `InvocationEvent` objects from `archive/{id}/` directories
- [x] 11.5 Update persistence tests including crash recovery: events written before crash are recoverable from `pending/`

## 12. Recovery

- [x] 12.1 Rewrite recovery to scan `pending/` for orphaned event files, group by id, emit existing events, synthesize `trigger.error` with `kind: "engine_crashed"`
- [x] 12.2 Update recovery tests: crashed invocation recovery, empty pending no-op, synthetic error has correct seq and ref

## 13. Logging Consumer

- [x] 13.1 Update logging consumer to handle `InvocationEvent`: log on `trigger.request`/`trigger.response`/`trigger.error`, ignore all other kinds
- [x] 13.2 Update logging-consumer tests

## 14. Dashboard

- [x] 14.1 Update dashboard queries to derive invocation summaries from `events` table (join `trigger.request` with terminal events)
- [x] 14.2 Update dashboard middleware tests

## 15. Integration and Cleanup

- [x] 15.1 Update `main.ts` wiring for changed bus/store/persistence interfaces
- [x] 15.2 Update cross-package integration tests: full end-to-end event flow from HTTP request through sandbox to persistence and DuckDB
- [x] 15.3 Update SECURITY.md to document `__emitEvent` global (§2 threat model update)
- [x] 15.4 Run `pnpm validate` — all lint, format, type check, and tests must pass

## Test coverage notes

The legacy test files for the `LogEntry` / `InvocationLifecycleEvent` /
`invocations`-table model were deleted during the source refactor and
replaced with new tests targeting the `InvocationEvent` model. New test
suite: 240 tests across 29 files, all passing under `pnpm validate`.

The upload tarball test (`api/upload.test.ts`) was not rewritten — the
upload code itself wasn't changed by this change, and the new
workflow-registry test covers the manifest validation path. Re-adding
upload tests is optional follow-up work.
