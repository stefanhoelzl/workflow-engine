## Why

The QuickJS sandbox today places three responsibilities in the worker that are conceptually main-side concerns: the `seq` counter, the ref-stack, and event stamping. Any main-side event injection (limit-breach synthesis, future debug markers) must fabricate `seq` via a `lastSeenSeq + 1` mirror — most concretely, the in-flight `sandbox-resource-limits` change requires this workaround. Moving sequencing to main eliminates the wart class entirely and materially simplifies the worker, bridge, sandbox-context, and plugin-runtime by removing framing/stack bookkeeping spread across all four.

A secondary opportunity surfaced during scoping: the reserved event-prefix list (`fetch`, `mail`, `sql`, `timer`, `console`, `wasi`, `uncaught-error`) collapses into a single `system.*` prefix with a `name` field disambiguator, and the `ctx.emit` SDK surface drops its `EmitOptions` (`createsFrame`/`closesFrame`) flags in favour of suffix-derived framing. These aren't strictly required by the sequencing move, but they are the same shape of cleanup and ride together cheaply.

## What Changes

- **BREAKING**: Worker → Sandbox wire event drops `seq` and `ref`. The wire shape becomes `{kind, name, ts, at, input?, output?, error?, type}` where `type` is a typed framing discriminator: `"leaf" | { open: CallId } | { close: CallId }`. Sandbox stamps `seq`/`ref` based on `type` and the embedded callId. Framing is **NOT** derived from the kind string — `kind` is free-form metadata and the worker's stamping logic does not parse it.
- **BREAKING**: Reserved event-prefix list shrinks from 9 (`trigger`, `action`, `fetch`, `mail`, `sql`, `timer`, `console`, `wasi`, `uncaught-error`) to 3 (`trigger`, `action`, `system`). All host-call events flow under `system.*` with five conventional sub-kinds: `system.request`, `system.response`, `system.error`, `system.call` (leaf), `system.exception` (leaf, replaces `uncaught-error`). The `name` field disambiguates which host call (e.g. `name="fetch"`, `name="setTimeout"`, `name="console.log"`). The `*.request` / `*.response` / `*.error` naming remains a downstream **convention** (used by dashboards, logging filters, etc.) but is no longer load-bearing for framing.
- **BREAKING**: SDK `ctx.emit` reshapes to `(kind: string, options: EmitOptions): CallId` with explicit framing in `options.type`. `EmitOptions` carries `{name, input?, output?, error?, type?}` where `type?: "leaf" | "open" | { close: CallId }` and defaults to `"leaf"`. Opens (`type: "open"`) return the assigned CallId; closes (`type: { close: callId }`) carry their pair token structurally — closes literally cannot be expressed as a value without their callId, so the type system enforces pairing. `ctx.request(prefix: string, options: RequestOptions, fn): T | Promise<T>` reshapes symmetrically with `RequestOptions = {name, input?}`. The previous `EmitOptions` (`createsFrame`/`closesFrame` flags) is removed.
- **NEW**: Sandbox-owned `RunSequencer` with three internal methods: `start()` (open window), `next(wireEvent)` (stamp seq/ref, update refStack/callMap by kind suffix), `finish({closeReason}?)` (synthesise closes for any open frames if a reason is given, otherwise warn on dangling; zero state). No public `synthesise()` API — Sandbox auto-closes on observed worker death internally.
- **NEW**: Out-of-window events (worker emits while `runActive=false`, e.g. late guest async resolving during the post-`done` restore) route to the host `Logger` as `sandbox.event_outside_run`, NOT to the bus. Today's worker-side bridge silently drops them; the new path surfaces them as operator diagnostics.
- **REMOVED**: Worker-side `nextSeq`, `pushRef`, `popRef`, `currentRef`, `resetSeq`, `refStackDepth`, `truncateRefStackTo`, `setRunActive`, `clearRunActive`, `runActive` from `Bridge`. `FrameTracker` and `truncateFinalRefStack` from `plugin-runtime`. `bridgeFrameTracker` from `worker.ts`. The four helpers in `sandbox-context.ts` (`emitRequest`, `emitResponse`, `emitError`, separate `pluginEmit` framing branches) collapse. The previous SDK `EmitOptions` type (with `createsFrame`/`closesFrame` boolean flags) is replaced by the new `EmitOptions` shape carrying `name` + payload fields + the explicit `type` discriminator.
- Boundary 3 (`Sandbox → Executor` via `sb.onEvent`) preserves today's `SandboxEvent` shape bit-for-bit. `callId` is dropped at the Sandbox boundary — it's a worker-scoped pairing token, never leaked.
- Recovery's cold-start synthesis (`lastPersistedSeq + 1` from disk, used when no live worker exists) is **explicitly out of scope** — structurally distinct from in-process synthesis (no live `RunSequencer` to consult). Documented as a separate path in the recovery spec.

## Capabilities

### New Capabilities

(none — this is a refactor of existing capabilities)

### Modified Capabilities

- `sandbox`: Bridge contract changes (drops sequencing primitives, becomes marshalling/timing only); worker→main wire event shape changes; main-side `RunSequencer` added; out-of-window event routing via `Logger`; SDK `ctx.emit` signature changes; `EmitOptions` removed.
- `sandbox-stdlib`: `__reportErrorHost` emits `system.exception` instead of `uncaught-error`. Other guest-visible polyfills unchanged.
- `invocations`: Drop "limit-breach terminal reuses last-seen ts" workaround language; replace with sequencer-based stamping. R-8 stamping-boundary invariant splits: `ts/at/kind/name` worker-stamped, `seq/ref` Sandbox-stamped.
- `executor`: In-process synthesis (worker death mid-run) goes through Sandbox auto-close, not a `synthesise()` API. No code change required in executor itself; documentation update.
- `recovery`: Add explicit carve-out — cold-start synthesis (`lastPersistedSeq + 1` from disk) is structurally distinct from Sandbox sequencing and remains as-is.
- `dashboard-list-view`: Kind matchers update for `system.*` consolidation; `uncaught-error` glyph maps to `system.exception`.
- `logging-consumer`: Kind filters update — drops `fetch.*`/`mail.*`/`sql.*`/`timer.*`/`console.*`/`wasi.*` matchers in favour of `system.*` (with name-based filtering if needed).

## Impact

- **Affected packages**:
  - `packages/sandbox/src/` — `bridge-factory.ts`, `sandbox-context.ts`, `sandbox.ts`, `worker.ts`, `protocol.ts`, `plugin-runtime.ts`, plus a new `run-sequencer.ts`. Test files for each.
  - `packages/runtime/src/plugins/trigger.ts` — split open/close updates to capture and pass `callId` between `onBeforeRunStarted` and `onRunFinished`. `PluginSetup` host-side state grows one slot.
  - `packages/runtime/src/plugins/` — any plugin emitting `fetch.*`/`mail.*`/`sql.*`/`timer.*`/`console.*`/`wasi.*` migrates to `system.*` with `name` disambiguator.
  - `packages/sandbox-stdlib/src/` — `__reportErrorHost` handler emits `system.exception` instead of `uncaught-error`.
  - `packages/runtime/src/ui/dashboard/flamegraph.ts` and any other kind-matching consumer — update prefix matchers.
- **Affected APIs**:
  - SDK: `ctx.emit` signature change. `EmitOptions` type removed.
  - Reserved event prefixes (CLAUDE.md, SECURITY.md §2 R-7).
  - SECURITY.md §2 R-8 stamping-boundary text.
- **Bus / persistence / EventStore**: NO schema change. The `SandboxEvent` shape reaching `sb.onEvent` and downstream consumers is preserved bit-for-bit. Persistence files and DuckDB indexes are unaffected. Existing event archives remain valid.
- **Workflows**: NO author-visible change. Demo workflow needs no edits (workflow code does not observe its own emitted events). Workflows do not need to be re-uploaded as a result of this refactor — only as a result of any SDK-emitted events that change shape, which here means none on the author surface.
- **Migration**: Single coordinated change. Worker, Sandbox, SDK, runtime plugins, kind-matching consumers, and the reserved-prefix list all ship together. Add an entry to `CLAUDE.md` `## Upgrade notes` flagging the wire-shape break.
- **Out of scope**: Recovery's cold-start synthesis, the Promise.all sibling-open parent-attribution bug (acknowledged pre-existing), and any persistence/EventStore schema change.
