## Why

Today's runtime models workflows as event-driven fan-out: triggers emit events, actions subscribe via `on:`, and the scheduler dispatches each event to all matching actions. This shape excludes a load-bearing use case — an HTTP trigger whose response is computed by an action — because actions cannot return values to their caller. It also forces sequential dataflow ("parse → enrich → store") to be threaded through chains of intermediate event types, which is verbose and obscures intent for the lightweight service-wiring workflows this engine targets.

Industry peers (trigger.dev, Windmill, n8n, Zapier) all sit on the publisher side; only trigger.dev — the closest fit for a TypeScript code-as-source-of-truth project — solves the dynamic-response problem cleanly, and it does so by making tasks typed callable functions composed in code. This change inverts the engine to that model: actions become typed functions called directly from trigger handlers, the handler's return value becomes the HTTP response, and the entire event-graph machinery (events, `emit()`, `on:`, fan-out, scheduler, work queue, EventSource) is removed.

## What Changes

- **BREAKING**: SDK API replaced. Drop `createWorkflow().event().trigger().action()` builder phasing, `event()`, `emit()`, `on:`, `subscribers`, `ctx` parameter, fan-out semantics. Add declarative `defineWorkflow`, `action`, `httpTrigger` factories returning brand-symbol-marked typed objects. Action handlers receive only `(input)`; trigger handlers receive only `(payload)` and return `{status?, body?, headers?}` (the literal HTTP response).
- **BREAKING**: One workflow per file. Vite-plugin emits one bundle per workflow file (not per action). Plugin discovers exports by brand symbol equality, not by reference identity. Action identity = export name.
- **BREAKING**: Manifest reshaped. Drop `events[]`. Add per-action `input`/`output` JSON schemas. Drop per-action `on:`/`emits:`. Action env folded into a single workflow-level `env` map.
- **BREAKING**: Action calls become typed function calls (`await sendNotification(input)`). New sandbox bridge global `__hostCallAction(name, input)` dispatches typed calls with Zod input/output validation; calls run in the same QuickJS context. Action calls are nested function calls within one trigger invocation, NOT separate persisted invocations.
- **BREAKING**: HTTP trigger response is the handler's return value. Static `response: {status, body}` config removed; the handler chooses the response per invocation. Returned shape is `{status?, body?, headers?}` with sensible defaults (200, "", {}). Throws map to 500 + failed invocation.
- **NEW**: `Executor` component owns invocation lifecycle: per-workflow runQueue (one trigger invocation at a time per workflow), sandbox handler dispatch, lifecycle event emission to the bus. Single method `executor.invoke(workflow, trigger, payload) → Promise<HttpTriggerResult>`.
- **NEW**: Invocation lifecycle records replace event-graph events. Each invocation persists once at completion as `archive/<id>.json` with `{workflow, trigger, input, output|error, status, startedAt, completedAt}`. `pending/<id>.json` written at start, removed at completion.
- **NEW**: `recover()` startup function scans `pending/` and writes `failed: engine_crashed` archive entries for each. EventStore consumer bootstraps its index by scanning `archive/` directly at init.
- **REMOVED**: `services/scheduler.ts`, `event-source.ts`, `event-bus/work-queue.ts`, `actions/index.ts` (old action shape), `context/` (no ctx), all event/`emit`/`on:` SDK surface.
- **REMOVED (v1 dashboard scope cut)**: dashboard timeline, detail page, filters, replay/retry buttons. Dashboard reduced to a single invocation list view. Dashboard timeline spec deleted.
- **DEFERRED (NOT in v1)**: retry, journal recording, source-hash binding, replay, determinism polyfills (Math.random, Date.now overrides), subscribers / fan-out at trigger, cross-workflow action calls, dashboard detail / flame graph / live streaming. The v1 surface is designed to admit these later without SDK or storage migration.
- Per-workflow serialization (one trigger invocation at a time per workflow) replaces the global concurrency limit. Cross-workflow invocations remain parallel.

## Capabilities

### New Capabilities

- `executor`: Invocation lifecycle orchestration. Per-workflow runQueue serialization, sandbox handler dispatch, lifecycle event emission to the bus. Replaces scheduler + event-source.
- `invocations`: Invocation lifecycle records (one per trigger invocation). Replaces event-graph events as the unit of persistence and indexing. Single `archive/<id>.json` per completed invocation; `pending/<id>.json` while in flight.
- `http-trigger`: HTTP trigger as a first-class concrete trigger type with brand `HTTP_TRIGGER_BRAND`, `httpTrigger({path, method?, body?, query?, params?, handler})` factory, handler return value as response. Carves trigger-type-specific behaviour out of the abstract `triggers` spec.
- `recovery`: One-shot startup function that sweeps crashed `pending/` invocations to `archive/` with `status: failed, reason: engine_crashed`, then completes. Distinct from the persistence consumer's prior `recover()` method.

### Modified Capabilities

- `sdk`: Drop `createWorkflow` builder + phasing, `event()`, `emit()`, `on:`, `subscribers`, `ctx` parameter, action `name`/`emits`/`on:` fields. Add `defineWorkflow`, `action`, `httpTrigger` factories returning brand-symbol-marked typed objects. Add `Action` callable interface and per-trigger-type concrete `HttpTrigger` interface.
- `actions`: Action becomes a typed callable with required Zod `input`/`output` schemas, no `on:`, no `emits`, no `ctx`. Identity = export name. Callable from trigger handlers and other actions.
- `triggers`: Becomes the abstract umbrella spec only. Concrete trigger implementations live in their own specs (`http-trigger` for HTTP). Remove static-response config; remove fan-out subscriber model; trigger has exactly one handler whose return value is the response (for HTTP).
- `sandbox`: Add `__hostCallAction(name, input)` bridge global for typed action dispatch with Zod input/output validation. Action calls run in the same QuickJS context (not separate sandboxes). No determinism polyfills in v1.
- `vite-plugin`: Emit one bundle per workflow file (not per action). Discover workflow/action/trigger exports by brand symbol on the export value. Workflow name defaults to filestem when `defineWorkflow({name})` is omitted. Manifest shape updated.
- `workflow-manifest`: Remove `events[]`. Per action: add `input`/`output` JSON schemas; remove `on`/`emits`/per-action `env`. Per trigger: keep `name/type/path/method/body/params`; remove static `response`. Add workflow-level `env` map.
- `workflow-build`: Per-workflow bundle replaces per-action bundles. Single output `.js` per workflow.
- `workflow-loading`: Load one bundle per workflow into the workflow's QuickJS sandbox.
- `workflow-registry`: Expose per-workflow `{name, env, sandbox, actions[], triggers[]}`. Remove event registry.
- `persistence`: Switch from per-state-transition append to one `pending/<id>.json` at start + one `archive/<id>.json` at completion. Persist invocation records, not RuntimeEvents. Remain a bus consumer.
- `event-bus`: Dispatch invocation lifecycle records (`started`, `completed`, `failed`) instead of RuntimeEvents. Synchronous ordered dispatch unchanged.
- `event-store`: Index invocation lifecycle records (workflow, trigger, status, startedAt, completedAt). Bootstrap by scanning `archive/` at init. Remove event-graph queries.
- `logging-consumer`: Log invocation lifecycle transitions instead of event state transitions.
- `payload-validation`: Validate trigger payloads on ingress. Validate action `input` and `output` at the sandbox bridge in both directions.
- `service-lifecycle`: Wire executor + recovery + bus consumers in startup. Remove scheduler service. Run `recover()` once before HTTP server starts.
- `dashboard-list-view`: Read invocations from EventStore (workflow, trigger, status, started, duration). Remove correlation/event-graph notion from the list.
- `webhooks-status`: Continue to expose `GET /webhooks/` health probe; semantics unchanged but driven from the new HTTP trigger registry.
- `define-workflow`: Replaced by the SDK's `defineWorkflow({name?, env?})` factory. Spec content collapses into the `sdk` spec; this spec is removed.
- `events`: REMOVED. No event types, schemas, or registry in v1.
- `event-source`: REMOVED. Absorbed into `executor`.
- `event-queue`, `work-queue`, `fs-queue`: REMOVED. No work queue; per-workflow runQueue is internal to the executor and not a standalone capability.
- `scheduler`: REMOVED. Replaced by `executor`.
- `context`: REMOVED. Handlers receive `(input)` / `(payload)` only; env via module-scoped `workflow.env`.
- `dashboard-timeline`, `dashboard-middleware`: REMOVED in v1 scope cut.

## Impact

- **SDK package** (`packages/sdk/`): full rewrite of `src/index.ts`. Drop builder phasing, event API, ctx. Add brand symbols, `defineWorkflow`, `action`, `httpTrigger`, `Action`/`HttpTrigger`/`Workflow` typed interfaces.
- **Vite plugin** (`packages/vite-plugin/`): per-workflow bundling, brand-based export discovery, new manifest emission, drop SDK runtime stub for `ctx.emit`.
- **Sandbox** (`packages/sandbox/`): add `__hostCallAction` bridge global; otherwise unchanged.
- **Runtime** (`packages/runtime/`): delete `services/scheduler.ts`, `event-source.ts`, `event-bus/work-queue.ts`, `actions/`, `context/`. Add `executor/` (index + run-queue) and `recovery.ts`. Rewrite `triggers/http.ts` as parse + delegate + shape response. Update `event-bus/persistence.ts`, `event-store.ts`, `logging-consumer.ts` for invocation lifecycle records. Update `workflow-registry.ts` for new manifest. Delete `ui/dashboard/timeline.ts` and related.
- **Workflows** (`workflows/cronitor.ts`): rewrite from two-action-event-chain to one-action-direct-call (~75 lines → ~50 lines).
- **Tests**: SDK builder tests, scheduler tests, event-source tests, work-queue tests, fan-out tests all replaced by executor + invocation-lifecycle + new SDK tests.
- **Dependencies**: no new runtime dependencies. Zod and QuickJS unchanged.
- **Security invariants** (SECURITY.md §2): host-bridge surface gains exactly one new global (`__hostCallAction`); JSON-only marshal preserved. Sandbox isolation model unchanged.
- **Observability**: dashboard list view continues to function; flame graph and detail page deferred; existing pino-based structured logging continues with new event shapes.
- **Migration**: existing `cronitor.ts` workflow rewritten as part of this change; no other user workflows exist in-repo.
