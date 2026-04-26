## Why

Trigger error logging today is split inconsistently across HTTP, cron, and IMAP. Cron and IMAP write Pino logs (`logger.warn`/`logger.error`) on every host-side failure mode — connect refused, search failed, fetch failed, malformed cron expression — but emit no dashboard event, leaving workflow authors blind to setup problems they could fix themselves. Conversely, the same Pino calls also fire when the engine itself bugs out (registry-built `fire` closure throws), spamming operators with noise classified identically to author misconfiguration. The handler-throw path is fine (sandbox plugin emits paired `trigger.request`/`trigger.error`), but the pre-dispatch surface needs a coherent policy: engine bugs go to operators (logs), author misconfigurations go to authors (dashboard).

## What Changes

- Introduce a new leaf event kind **`trigger.exception`** for author-fixable pre-dispatch failures. Unlike `trigger.error`, it is emitted host-side without a paired `trigger.request` and does not close any frame. Payload carries `{ name, error: { message }, ...stage-specific fields }` with no stack trace.
- Add `executor.fail(owner, repo, workflow, descriptor, params)` as a sibling to `executor.invoke`. `fail` skips the sandbox lookup and run queue, mints a synthetic `evt_*` invocation id, stamps every sandbox-and-runtime-owned scalar (`id`, `kind`, `name`, `seq=0`, `ref=0`, `ts=0`, `at`, `owner`, `repo`, `workflow`, `workflowSha`, `invocationId`), and emits the leaf event onto the bus. The stamping primitive (`createTriggerExceptionEmitter`) lives inside the executor module as the single chokepoint where SECURITY.md R-8's carve-out is enforced.
- Add `buildException(executor, owner, repo, workflow, descriptor)` as a sibling to `buildFire`. It returns a per-trigger callable bound to identity; payload (`name`, `error`, `details`) is passed call-time. The `WorkflowRegistry` builds the closure alongside `buildFire` and attaches it to `TriggerEntry` as `entry.exception`. **`TriggerSource` implementations call `entry.exception(...)` only — they never touch the bus or the executor directly**, mirroring the `entry.fire(...)` contract that already governs handler dispatch (`source.ts` line 16: "Backends never touch the Executor — they invoke `entry.fire(input)`").
- Rewrite IMAP poll-loop error handling. Drop six `logger.warn`/`logger.error` call sites for connect/mailboxOpen/search/fetch/disposition failures; replace with a per-cycle aggregator that calls `srcEntry.entry.exception({ name: "imap.poll-failed", … })` **at most once** per `runPoll()`. Per-UID fetch failures accumulate into `failedUids: number[]`; fatal stages emit immediately with the appropriate `stage` discriminator. The sticky `imap.fire-threw` `logger.error` (engine bug, registry closure threw) stays as a log-only line with no event.
- Cron has **no behavior change**. Both its failure paths (`cron.schedule-invalid`, `cron.fire-threw`) are engine bugs — Zod was supposed to gate the schedule, and the registry closure isn't supposed to throw. They remain `logger.error` only with no dashboard event.
- HTTP triggers are unchanged. Body parse / Zod validation failures stay 4xx-response-only with no log and no event (the response code is the signal to the caller; the *workflow author* cannot fix arbitrary external garbage).
- Invocation record builder learns to reconstruct an "invocation" from a single `trigger.exception` leaf event: `input: {}`, `startedAt === completedAt === event.at`, `status: "failed"`, `error: event.payload.error`. No new required fields on the record.
- Dashboard invocation list renders `trigger.exception` entries inline with a distinct icon (e.g. wrench/settings) and label ("trigger setup failed") to differentiate from handler-throw `trigger.error` entries.
- `logging-consumer.ts` is unchanged: it only routes `trigger.{request,response,error}`. `trigger.exception` is intentionally not logged (per policy: author failures don't go to operator logs).

## Capabilities

### New Capabilities
<!-- None — `trigger.exception` belongs to the existing `invocations` capability. -->

### Modified Capabilities
- `invocations`: Adds `trigger.exception` to the EventKind union; documents the host-side `executor.fail` stamping path (no sandbox, no sequencer); defines the synthetic invocation record shape for single-leaf invocations.
- `executor`: Adds `executor.fail(owner, repo, workflow, descriptor, params)` as a sibling to `executor.invoke` for emitting `trigger.exception` leaf events; modifies "Executor is called only from fire closures" to also cover the parallel "called from exception closures" rule.
- `triggers`: Modifies `TriggerEntry` to carry a third field `readonly exception: (params) => Promise<void>` alongside `fire`; documents that backends route pre-dispatch failures through `entry.exception` and never touch the bus, executor, or stamping primitives directly.
- `imap-trigger`: Replaces six per-call-site `logger.warn`/`logger.error` calls with a per-cycle aggregator that calls `entry.exception(...)` at most once per `runPoll()`; documents the `imap.poll-failed` payload shape and the β.2 emission rule (per-UID fetch failures emit even on cycles that otherwise succeed).
- `logging-consumer`: Documents that `trigger.exception` is intentionally NOT logged (author-failure events don't go to operator pino logs).
- `dashboard-list-view`: Documents rendering of single-leaf `trigger.exception` invocations inline in the invocation list with distinct iconography.

## Impact

- **Code**: `packages/core/src/index.ts` (EventKind union); new `executor.fail` method in `packages/runtime/src/executor/index.ts` plus its internal stamping primitive (`packages/runtime/src/executor/exception.ts` or sibling); new `buildException` factory in `packages/runtime/src/triggers/build-exception.ts` (sibling to `build-fire.ts`); `TriggerEntry.exception` field on `packages/runtime/src/triggers/source.ts`; `WorkflowRegistry` wires `buildException` alongside `buildFire`; `packages/runtime/src/triggers/imap.ts` (per-cycle aggregator calls `entry.exception(...)`); dashboard query change in `packages/runtime/src/ui/dashboard/middleware.ts`; renderer in `packages/runtime/src/ui/dashboard/page.ts`; flamegraph instant-marker in `packages/runtime/src/ui/dashboard/flamegraph.ts`.
- **Specs**: Modifications to `invocations`, `imap-trigger`, `logging-consumer`, `dashboard-list-view` per the list above.
- **SECURITY.md**: R-7 reserved-prefix list adds `trigger.exception`; R-8 stamping boundary documents the new "runtime-only emission for `trigger.exception`" path.
- **Persistence / DuckDB index**: New event kind needs to flow through unchanged — no schema migration expected since the existing index keys on `(owner, repo, invocationId)` and not `kind`. Worth verifying in design.md.
- **PR split**: Two PRs. PR1 adds the kind, helper, invocation record builder change, dashboard renderer, spec/SECURITY updates (kind unused but valid). PR2 rewrites IMAP call sites + imap-trigger spec delta. Cron is not touched.
- **Author migration**: None. Existing workflows behave identically; authors with broken IMAP triggers gain dashboard visibility into setup failures they previously had to ask the operator about.
