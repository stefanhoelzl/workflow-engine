## Context

The current runtime models workflows as a directed graph of typed events flowing between triggers and actions. Triggers emit events, actions subscribe via `on:`, and a scheduler loop dequeues events from a `WorkQueue` and dispatches each to all matching actions through a sandbox boundary. Fan-out is native (one event → N independent action invocations); state transitions are persisted as append-only files; the dashboard reconstructs the workflow as a graph from the event store.

This shape solves multi-consumer broadcast cleanly but excludes any workflow whose trigger needs a *dynamic response*: an HTTP webhook returning a payload computed by an action cannot be expressed because actions cannot return values to their caller. Additionally, sequential dataflow ("parse → enrich → store") forces authors to thread data through chains of intermediate event types, obscuring intent for the lightweight service-wiring use cases this engine targets (Slack/Stripe/GitHub webhooks, support-mail-to-ticket flows, "PR-merged → close-ticket" automations).

Industry peers in this niche split cleanly:
- **Visual flow tools** (n8n, Windmill, Zapier): publisher-side wiring, document-as-graph, name-keyed expressions for data flow. Fragile under refactor; not applicable to a TypeScript code-as-source-of-truth project.
- **Code-first task runners** (trigger.dev): typed callable tasks composed via direct `await child(input)` calls. Refactor-safe via TS imports; dynamic responses fall out naturally as the root task's return value.

Constraints that bound the redesign:
- TypeScript-first authoring (`workflow.ts` is the spec, no visual canvas).
- QuickJS WASM sandbox preserved as the action isolation boundary (`SECURITY.md` §2).
- All host/sandbox boundary crossings remain JSON-marshaled.
- Per-workflow sandbox + worker-thread isolation preserved (today's `@workflow-engine/sandbox` model).
- "Lightweight service wiring" workload — no heavy computation, no long-running tasks, no durable workflows-as-databases ambition for v1.
- Solo-maintainer codebase; v1 surface area aggressively minimized.

## Goals / Non-Goals

**Goals:**

- Triggers can return a dynamic, action-computed HTTP response.
- Actions compose as typed function calls with refactor-safe TypeScript imports.
- Workflow file is the single source of truth for wiring, with all references resolvable by TypeScript (no string-keyed cross-references).
- Sequential dataflow expressed as straight-line code with native control flow (`if`, `try/catch`, `Promise.all`).
- Sandbox isolation boundary preserved; host bridge surface grows by exactly one new global.
- Existing `cronitor.ts` workflow rewritten to demonstrate the new shape; runs end-to-end on the same QuickJS-per-workflow infrastructure.
- v1 surface designed so deferred features (retry, journal, replay, polyfills, source hashing, subscribers, cross-workflow calls) can land later without SDK migration or storage migration.

**Non-Goals:**

- Durable execution / Temporal-style replay in v1. Journal recording, source-hash binding, hash-mismatch handling, and determinism polyfills (`Math.random`, `Date.now` overrides) are explicitly deferred. The architecture admits them later.
- Per-action retry policies and operator-triggered retry from the dashboard are deferred. Handler throws → invocation marked `failed`, no auto-retry, no manual UI.
- Subscribers / fan-out at the trigger level. Trigger has exactly one handler in v1.
- `emit()` as a broadcast primitive. All wiring is direct call. True pub/sub broadcast is deferred.
- Cross-workflow action calls. Each workflow is a sealed unit (own sandbox, own env, own bundle).
- Dashboard detail page, filters, replay/retry buttons, flame graph rendering, live streaming. Dashboard reduced to a single invocation list.
- Multi-instance deployment, hot-reload of workflows.

## Decisions

### D1: Function-call composition over event fan-out

**Decision:** Workflows compose by direct typed function calls (`await sendNotification(input)`), not by emitting/subscribing to events.

**Alternatives considered:**

1. **Hybrid: keep fan-out + add request/reply at trigger boundary.** A trigger could declare a "primary handler" (whose return value becomes the response) plus N independent fan-out subscribers. Rejected because it doubles the conceptual surface (two ways to wire on the same event), introduces ambiguity about ordering and failure coupling, and the open-extension benefit of fan-out doesn't apply to a single-author code-as-config project.
2. **Trigger fan-out only, dynamic response via back-channel.** A trigger fans out to N actions; one action publishes a "response" event correlated by ID; the trigger middleware awaits and serializes. Rejected as a re-implementation of request/reply with extra plumbing — solves the response problem at the cost of more machinery.
3. **Pure event fan-out preserved; defer dynamic responses to v2.** Status quo. Rejected because it defers the load-bearing use case indefinitely and keeps the verbose event-chain pattern for sequential flows.

**Rationale:** Function calls match the dominant pattern for service-wiring workloads (verified by enumerating concrete use cases: PR-opened → label/assign/notify, support-mail → ticket → reply, PR-merged → close-ticket, Slack-slash → response). Fan-out remains expressible as `Promise.all([a(x), b(x), c(x)])` where genuinely needed; loss is the open-extension property (third party drops in a subscriber), which has zero relevance for a single-author project. trigger.dev's adoption of this exact model in the same niche is corroborating evidence.

### D2: Trigger has exactly one handler; handler return value is the HTTP response

**Decision:** Each `httpTrigger({...})` declares a single `handler: async (payload) => ({status?, body?, headers?})`. The returned object is the literal HTTP response (status defaults to 200, body to `""`, headers to `{}`). No subscribers, no fan-out at the trigger.

**Alternatives considered:**

1. **One trigger → 1 responder + N independent subscribers** (Option B from interview): rejected, introduces two concepts on the same event with subtle ordering and failure-coupling questions.
2. **One trigger → 1 entry handler that explicitly `emit()`s for fan-out** (Option A from interview): rejected with the broader removal of `emit()`. Fan-out, when needed, is `Promise.all` inside the handler.
3. **Two trigger types (sync vs async)**: rejected as forcing authors to commit at trigger-definition time to whether they will ever want a dynamic response.

**Rationale:** Aligns with trigger.dev's "task return value is the HTTP response" model. Matches the dominant case directly and makes fan-out an explicit `Promise.all` line when needed. Returning the response object explicitly (vs. plain-value-as-body or `ctx.respond()`) is unambiguous, type-checked, and extensible (e.g., add `cookies` later) — Windmill's `windmill_headers` pattern but cleaner.

### D3: Drop events / `emit()` / `on:` / `event-source` / `work-queue` / `scheduler` entirely

**Decision:** v1 has no event types, no event registry, no `emit()` SDK surface, no `on:` field, no fan-out at the wiring level. The runtime components implementing these (event-source.ts, work-queue.ts, scheduler.ts) are deleted.

**Alternatives considered:**

1. **Keep `emit()` as a broadcast escape hatch for cross-workflow audit/metrics**: rejected for v1 because it re-introduces subscriber-side wiring with all its tradeoffs (string-typed, harder to refactor) for a use case that doesn't exist in the current target workloads.
2. **Keep events but make them typed handles** (`const e = workflow.event(schema); emit(e, payload)`): rejected as adding a third primitive (alongside actions and triggers) without a use case to justify it.

**Rationale:** Maximum simplification consistent with the use-case analysis. If true broadcast pub/sub is ever needed, it can be added back as an opt-in primitive without changing the surface for the function-call majority.

### D4: One sandbox per workflow, one trigger invocation at a time per workflow

**Decision:** Preserve today's per-workflow QuickJS context. Add a per-workflow runQueue (a tiny Promise-chain serializer) that ensures one trigger invocation runs at a time. Cross-workflow invocations remain parallel.

**Alternatives considered:**

1. **Unbounded concurrent invocations per workflow**: rejected because the user explicitly chose "one sandbox per workflow and one invocation per sandbox" — predictable behavior, no concurrency hazards inside the sandbox, simpler reasoning about (eventual, future) module-state determinism.
2. **Per-trigger or per-action concurrency limits**: rejected as premature configuration surface. Per-workflow serialization is the simpler default.
3. **Sandbox-per-action invocation**: rejected — defeats today's reuse optimization, increases worker-thread count dramatically for negligible isolation gain (actions within a workflow already share a trust boundary).

**Tradeoff acknowledged:** Two webhooks arriving 100ms apart for the same workflow serialize — webhook B waits for webhook A's handler to return. Acceptable because handlers are short for the target workloads. Cross-workflow parallelism preserves throughput when the load is spread across workflows.

### D5: `Executor` component owns invocation lifecycle; absorbs `EventSource`

**Decision:** A single `Executor` component owns: per-workflow runQueue, sandbox handler dispatch, persistence calls (via the bus), lifecycle event emission to the bus. `EventSource` is deleted; its remaining responsibilities (lifecycle event emission) collapse into the executor. The HTTP middleware shrinks to parse + delegate + shape response.

**Alternatives considered:**

1. **Keep EventSource as a separate lifecycle-emitter component**: rejected because in v1 the only lifecycle events are `started/completed/failed` and they always flow from the executor — there's no second emission site. A separate component is ceremony without payoff.
2. **HTTP middleware drives lifecycle directly (no executor)**: rejected — mixes HTTP-layer concerns (parsing, response shaping) with execution-layer concerns (runQueue, sandbox, bus emission, retry-when-it-lands). Future non-HTTP triggers would re-implement the same logic.

### D6: Persistence stays a bus consumer; bus dispatch is synchronous-ordered

**Decision:** The executor emits invocation lifecycle events via `await bus.emit(event)`. The bus dispatches synchronously through ordered consumers: persistence first (commits to disk), then EventStore (DuckDB index), then logging. Persistence is NOT promoted to a direct service of the executor.

**Alternatives considered:**

1. **Promote persistence to a direct service** (executor calls `persistence.writePending`/`writeArchive` directly): rejected because it forces the executor to coordinate two concerns (write + emit) in the right order on every code path; drift becomes a class of bug. Bus-as-coordinator is the single coupling point.
2. **Asynchronous bus dispatch**: rejected — persistence must complete before the executor returns to the HTTP middleware (otherwise a crash window opens after response and before persistence). Sync ordered dispatch gives that guarantee for free.

### D7: Branded typed objects + brand-symbol export discovery

**Decision:** `defineWorkflow()`, `action()`, and `httpTrigger()` return objects carrying `Symbol.for("@workflow-engine/<kind>")` brand symbols. The vite-plugin walks workflow file exports and identifies actions/triggers/workflow-config by brand check, not by reference equality on the handler function.

**Alternatives considered:**

1. **Reference equality** (today's mechanism — vite-plugin matches `fn === action.handler`): rejected as fragile under bundler transforms (function references can be wrapped, the equality contract is implicit).
2. **Decorators**: rejected — TS decorators ergonomics are still in flux; complicates the sandbox boundary; doesn't add value over branded objects.

**Implementation note:** `action()` returns a callable function with the brand attached as a property (`Object.assign(fn, {[ACTION_BRAND]: true, input, output, handler})`), so authors write `await sendNotification(input)` and the plugin still recognizes the export.

### D8: One factory per concrete trigger type; abstract `Trigger` is a type union only

**Decision:** Each concrete trigger type ships its own SDK factory (`httpTrigger({...}) → HttpTrigger`). Future trigger types add their own factory, brand symbol, and concrete type. The `Trigger` type is a union (`type Trigger = HttpTrigger`) used by runtime dispatch; authors never write `Trigger` themselves.

**Alternatives considered:**

1. **Generic `trigger(triggerDef, {handler})` factory wrapping a type-specific config builder**: rejected — different trigger types share nothing at the config level (HTTP needs path/body schema; cron needs schedule; queue needs queue name + visibility timeout). The generic wrapper adds nothing but indirection.

### D9: Module-scoped `workflow.env`; no `ctx` parameter on handlers

**Decision:** Workflow-level env is declared on `defineWorkflow({env: {...}})`. The returned `Workflow` object exposes `env` as a frozen record. Handlers reference it via the imported workflow object (`workflow.env.NEXTCLOUD_URL`). Handler signatures are `(input)` for actions and `(payload)` for triggers — no `ctx`.

**Alternatives considered:**

1. **Keep `ctx` (handler receives `(input, ctx)`): rejected — the only thing left for ctx to carry is env; module-scope reference is cleaner and matches the determinism-friendly "set once at load, immutable thereafter" pattern.
2. **Per-action env still possible**: deferred. Workflow-level env is enough for v1; per-action env can be added if a use case appears.

### D10: One workflow per file; one bundle per workflow

**Decision:** Each `workflows/*.ts` file is exactly one workflow. Vite-plugin emits one bundled `.js` per workflow file (not per action). Workflow name defaults to filestem if `defineWorkflow({name})` is omitted.

**Alternatives considered:**

1. **Multiple workflows per file**: rejected — needs explicit workflow scoping for every action/trigger declaration; no clear use case.
2. **Per-action bundling (today's model)**: rejected — needs N sandbox loads per workflow; per-workflow bundling matches per-workflow sandbox; smaller bundle artifact tree.

### D11: Action calls run in the same QuickJS context; `__hostCallAction` bridge for validation + audit

**Decision:** When a handler does `await sendNotification(input)`, the SDK-returned callable is a sandbox-side wrapper that, in order:

1. Calls `__hostCallAction("sendNotification", input)`. The host validates `input` against the declared input JSON Schema (Ajv, sourced from the manifest), audit-logs the invocation, and returns `undefined`. The host does NOT dispatch the handler.
2. Invokes the author's handler as a plain JS function call in the same QuickJS context.
3. Validates the handler's return value against the output Zod schema using the Zod bundle inlined in the workflow bundle.

Action calls are nested function calls within one trigger invocation, NOT separate persisted invocations. No nested `sandbox.run()` happens — the wrapper runs inside the current run's evaluation, so the `sandbox.run` re-entry hazard (shared `onMessage` listener across concurrent runs) is avoided by construction.

**Alternatives considered:**

1. **Sandbox-per-action**: rejected (see D4).
2. **Host re-enters the sandbox to dispatch the handler** (e.g., via a nested `sandbox.run`): rejected because `sandbox.run` is not re-entrant in the current worker protocol — concurrent runs race on the single `onMessage` listener. Adding run-ID correlation would cross the sandbox-package boundary for no additional guarantee over the in-wrapper dispatch.
3. **Host imports the workflow bundle in Node and dispatches the handler there**: rejected because it violates the sandbox isolation invariant (§SECURITY.md §2) — action code would run with full Node API access. Compromised action code could reach `process`, `fs`, `require`, etc.
4. **In-sandbox direct call without bridge round-trip**: rejected because input validation and audit logging must be authoritative (schemas live in the manifest, not in the sandbox) and must execute even when the sandbox copy of Zod is compromised.
5. **Output validation on the host**: rejected because in this model the handler runs inside the sandbox; the output is already a guest-side value, so host-side validation would require a second bridge crossing. Validating in-sandbox with the bundled Zod is one crossing less and adequate — if guest code tampers with its own Zod copy, the self-harm is contained; the manifest-side input validation (run on the host) remains the canonical contract.

### D12: Persist on invocation completion only; user-code throws preserve state

**Decision:** Persistence writes `pending/<id>.json` at invocation start and `archive/<id>.json` at completion (success or failure). User-code throws are caught by the executor; the failed-state archive is written and the HTTP response is 500. Workflow-engine crashes (process death) lose any in-flight invocation; recovery sweeps `pending/` to `failed: engine_crashed` on next startup.

**Alternatives considered:**

1. **Persist after every bridge call**: deferred (would enable durable execution / replay). Not in v1 scope; would require journal infrastructure.
2. **Periodic persistence**: rejected as the worst-of-both — neither the simplicity of completion-only nor the soundness of per-call.

**Rationale:** For lightweight service-wiring with second-scale handlers, engine crashes are rare. The "never re-fire externals on retry" guarantee that durable execution provides isn't needed in v1 because there's no retry. Future v2 can add per-call journaling without changing the v1 storage shape (journal would be an additional sub-document in the archive record).

### D13: Recovery is a one-shot startup function; not a method on the executor

**Decision:** A standalone `recover(persistence, bus)` function in `runtime/recovery.ts` runs once at startup. It scans `pending/`, constructs a `failed: engine_crashed` lifecycle event for each, and emits via the bus (which writes the archive entry through the persistence consumer). The EventStore consumer separately bootstraps its index by scanning `archive/` directly at init.

**Alternatives considered:**

1. **`Executor.recover()` method**: rejected — recovery touches persistence + bus only, doesn't need the executor's runQueue/sandbox concerns. Cleaner as a standalone startup task.
2. **Auto-retry crashed pending invocations on startup**: rejected — no journal in v1, so retry would re-fire externals without operator awareness. Marking as `failed: engine_crashed` is the safest default.

## Risks / Trade-offs

- **[Per-workflow head-of-line blocking]** Two HTTP requests for the same workflow arriving 100ms apart serialize. → **Mitigation:** target workloads have second-scale handlers; cross-workflow parallelism preserves throughput. Per-workflow concurrency limit is a future option.
- **[Loss of open extensibility]** Third-party packages cannot drop in subscribers to existing events. → **Mitigation:** not a real use case for a single-author code-as-config project. Code reuse happens via shared TS modules imported into each workflow.
- **[No durable execution in v1]** Engine crashes lose in-flight invocations; retries (when added later) will re-fire externals because there's no journal. → **Mitigation:** v1 has no retry at all. v2 can add journal + retry without breaking v1 workflows; the sandbox bridge already centralizes all non-determinism.
- **[Module-state determinism not enforced]** Authors can write mutable top-level state today; v1 has no replay so this is silently fine, but it will become unsafe when journaling lands. → **Mitigation:** document the contract now; add lint warnings / sandbox-side checks when journaling is implemented; v1 workflows that respect the contract migrate cleanly.
- **[Manifest schema breaking change]** Existing manifests are incompatible. → **Mitigation:** only `cronitor.ts` exists in-repo; rewritten as part of this change. No external consumers.
- **[Rewrite scope]** SDK, vite-plugin, runtime, and workflow file all change in lockstep. → **Mitigation:** v1 surface is small; comprehensive test rewrite is bounded. Deletions outweigh additions in line count.
- **[Brand-symbol discovery requires preserved object shape]** If a future bundler optimization strips brand symbols, the vite-plugin discovery breaks silently. → **Mitigation:** brand symbol on a returned object value is a stable JS pattern; covered by integration tests that import the SDK exports, walk them, and assert detection.
- **[Single-trigger-handler limits future flexibility]** If subscribers / fan-out at the trigger become genuinely needed later, the SDK adds a new field rather than a new factory. → **Mitigation:** deliberate scope cut; reversible.

## Migration Plan

Single-PR rewrite. No phased rollout — v1 surface is incompatible with the current event model and the only in-repo workflow (`cronitor.ts`) is rewritten as part of the change. No external workflow authors to coordinate with.

**Steps:**

1. SDK rewrite (`packages/sdk/src/index.ts`): brand symbols, `defineWorkflow`/`action`/`httpTrigger` factories, types. Drop event/emit/on/builder/ctx surface.
2. Vite-plugin rewrite (`packages/vite-plugin/`): per-workflow bundling, brand-based discovery, new manifest emission. Drop SDK runtime stub for `ctx.emit`.
3. Sandbox additions (`packages/sandbox/`): `__hostCallAction(name, input)` global; otherwise unchanged.
4. Runtime restructure (`packages/runtime/`): delete scheduler, event-source, work-queue, actions/, context/. Add executor/, recovery.ts. Rewrite triggers/http.ts, workflow-registry.ts, event-bus consumers (persistence, event-store, logging-consumer) for invocation lifecycle records. Delete dashboard timeline; trim dashboard list view.
5. Rewrite `workflows/cronitor.ts` against the new SDK.
6. Test rewrite: delete scheduler/event-source/work-queue/fan-out tests; add executor + invocation-lifecycle + new SDK + new vite-plugin tests; refresh integration tests.
7. Update `openspec/project.md` to reflect the new architecture and remove event-driven references.

**Rollback:** revert the PR. State on disk between v0 (today's event files in `pending/`/`archive/`) and v1 (invocation files in same directories) is incompatible; rollback requires clearing storage. Acceptable because the local kind stack uses ephemeral storage and there is no production deployment depending on persisted history.

## Open Questions

- **Per-action env**: workflow-level env covers all v1 needs; if a use case for action-scoped env appears (limiting secret exposure to specific actions), the SDK can add an optional `env` field on `action({...})` later. Not blocking v1.
- **Trigger UI / form-based invocation**: today's `trigger-ui` capability lets operators manually fire a trigger from the dashboard. Whether it survives v1 unchanged or is deferred alongside the dashboard detail page is a small additional scope decision, not architecture-level.
- **Output schema for void-returning actions**: `z.void()` is the obvious choice; whether the SDK provides a special-cased shorthand (e.g., omitting `output` when handler returns nothing) is an ergonomics decision deferred to implementation.
- **`webhooks-status` GET response**: today returns 204 when triggers are registered, 503 otherwise. Behavior is preserved; the spec wording may need light editing to reference the new HTTP trigger registry rather than the old event-driven one.
