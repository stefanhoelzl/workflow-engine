## Context

The current state of trigger-error reporting is incoherent. Three triggers (`http`, `cron`, `imap`) follow three different policies, and the IMAP implementation diverges from the IMAP spec.

```
            CURRENT STATE — TRIGGER ERROR REPORTING
            ────────────────────────────────────────

  HTTP   ──►  handler throws  ──►  500 response + trigger.error (frame close)
              validation fails ──►  4xx response, no log, no event
              parse fails       ──►  4xx response, no log, no event

  CRON   ──►  handler throws        ──►  trigger.error (frame close)
              + logger.error("cron.fire-threw")        ◄── duplicate signal
              schedule-invalid       ──►  logger.error only, no event
                                                       ◄── invisible to author

  IMAP   ──►  handler throws        ──►  trigger.error (frame close)
              + logger.error("imap.fire-threw")        ◄── duplicate signal
              connect-failed         ──►  logger.warn only
              search-failed          ──►  logger.warn only
              fetch-failed (per UID) ──►  logger.warn only
              disposition-failed     ──►  logger.warn only
                                                       ◄── all invisible to author
                                                       ◄── all DIVERGES from spec
                                                           (spec says trigger.error)
```

The IMAP spec at `openspec/specs/imap-trigger/spec.md:255-299` requires `trigger.error` events with `reason` discriminators (`connect-failed`, `tls-failed`, `auth-failed`, `search-failed`, `fetch-failed`, `disposition-failed`). The implementation never wired this up — it emits Pino logs instead.

The handler-throw path (`packages/runtime/src/plugins/trigger.ts:54`) is the only working surface: the in-sandbox trigger plugin pairs `trigger.request`/`trigger.error` via the `RunSequencer`'s `CallId` framing.

Constraints from the rebased `system.*` consolidation (commit 2737b338):

- `seq` / `ref` are owned by the main-thread `RunSequencer`, one per sandbox run. There is no sequencer outside a run.
- Stamping boundary (SECURITY.md R-8): bridge stamps `kind`/`name`/`ts`/`at`/`input`/`output`/`error`; sequencer stamps `seq`/`ref`; runtime executor stamps `tenant`/`workflow`/`workflowSha`/`invocationId` (and `meta.dispatch` for `trigger.request`).
- Recovery already has precedent for *out-of-process* event synthesis when the worker is gone before terminal events were emitted (`invocations` spec "Recovery synthetic terminal" scenario).

Stakeholders: workflow authors (need pre-dispatch visibility), operators (need engine-bug logs without author-misconfig spam), and engine maintainers (need a clean event taxonomy that doesn't require carve-outs in the sequencer's pairing invariant).

## Goals / Non-Goals

**Goals:**

- Workflow authors see author-fixable trigger setup failures (IMAP host wrong, search expression rejected, server refuses connection) in the dashboard's invocation list.
- Operators stop receiving Pino warnings for author misconfiguration across a fleet of tenants. They still receive Pino errors for genuine engine bugs (registry closure throws, Zod-gated config slipping through).
- The IMAP source does not pollute the dashboard with one event per UID/per-failure when a server is misconfigured. A poll cycle produces at most one dashboard entry.
- The `RunSequencer`'s pairing invariant (every `*.error` closes a `*.request`) remains intact. No carve-outs for synthetic frames.
- HTTP triggers do not gain a new pre-dispatch surface that public webhook callers could weaponize to flood the dashboard.

**Non-Goals:**

- Cron behavior changes. Cron's two failure paths are both engine bugs by definition (Zod validates schedule + tz at upload; the registry closure isn't supposed to throw). They stay log-only.
- Reworking the handler-throw path. The sandbox-side `trigger.request`/`trigger.error` plugin in `packages/runtime/src/plugins/trigger.ts` is unchanged.
- Adding a new dashboard surface ("trigger health" panel). Pre-dispatch failures land in the existing invocation list with a distinct icon.
- HTTP body validation surfacing. The 4xx response IS the signal to the caller; surfacing it as a dashboard event would be DoS-able from the public `/webhooks/*` ingress.
- Recovery integration. Recovery's `engine_crashed` synthesis path is for *interrupted* invocations; pre-dispatch invocations are atomically terminal at emission time and don't intersect recovery semantics.

## Decisions

### Decision 1: New leaf event kind `trigger.exception`

Three candidates were considered:

| Option | Reuse | Cost | Verdict |
|---|---|---|---|
| `system.exception` | Existing (sandbox `reportError` only) | Broaden semantics: now also host-emitted, also for trigger-domain failures | **Rejected** — conflates engine-internal uncaught throws with author-config failures |
| `trigger.error` as a leaf | Existing kind | Carve-out in `RunSequencer` pairing invariant; recovery's `engine_crashed` discriminator already overloads this kind once | **Rejected** — pairing invariant is load-bearing for flamegraph and recovery |
| New leaf kind `trigger.exception` | One `EventKind` line | One `EventKind` entry, one SECURITY.md R-7 line | **Selected** |

Mirrors `system.exception`'s shape (leaf, no frame, no pairing) but lives in the `trigger.*` family because it carries trigger-scoped context (`workflow`, `trigger`, owner-stamped invocationId).

### Decision 2: Three-bucket policy

```
              EVENT vs LOG MATRIX
              ───────────────────

  Engine pre-dispatch failure   ──►  log only      [operator audience]
  Author pre-dispatch failure   ──►  event only    [author audience]
  Handler failure               ──►  event only    [author audience]
  Caller-driven failure (HTTP)  ──►  4xx response  [caller audience]
                                     no log, no event
```

Routing happens by *event kind* (clean), not by a payload `cause` field (would invert readability — readers would have to inspect the payload to know whether the event will log). The `logging-consumer` already routes on kind (`logging-consumer.ts:19-32`); it gains no new case for `trigger.exception` (silent by omission). Engine-bug call sites (`cron.ts:170`, `cron.ts:126`, `imap.ts:662`) keep their explicit `logger.error` calls and emit no event.

### Decision 3: Per-cycle aggregation for IMAP (β.2)

A poll over a folder with N broken messages must NOT produce N events. Considered three strategies:

| Strategy | Per failed cycle | Per failure site | Storm risk |
|---|---|---|---|
| (α) Transition gating | 1 (only on healthy→failing) | 0 | None, but hides root-cause changes |
| (β) Per-cycle | 1 | 0 | Bounded by poll interval |
| (γ) Per-site | 1 + N (UIDs) | many | High |

**Selected: (β) Per-cycle, with β.2 sub-rule** — per-UID fetch failures emit on cycles that *otherwise* succeed, even if connect/search/disposition all worked. A folder of 50 well-formed messages where 3 fail to fetch produces ONE `trigger.exception` per poll, with `failedUids: [12, 34, 56]`. This keeps the author informed without flooding.

Cron has no loop and no aggregation; per-cycle and per-site collapse to the same thing there. Cron is out of scope anyway (engine-only failure modes).

### Decision 4: Single `name: "imap.poll-failed"` with `stage` discriminator

Two sub-options for IMAP payload shape:

- **(I)** Single name, stage as field: `{name: "imap.poll-failed", stage: "connect" | "mailboxOpen" | "search" | "fetch" | "disposition", failedUids?: number[], error: {message}}`
- **(II)** Stage-specific names mirroring today's logger lines (`imap.connect-failed`, `imap.search-failed`, etc.)

**Selected: (I)**. Per-cycle aggregation already says "this poll didn't go well, here's what happened" — the stage is a sub-category of one concept. One name simplifies storage indexing, dashboard rendering, and the `EventKind.name` discriminator pattern.

The existing `imap-trigger` spec's "Error taxonomy" requirement (auth-failed/tls-failed split out from connect-failed) is collapsed: connect-time auth and TLS failures both surface under `stage: "connect"` with the underlying error message. The auth/TLS distinction is preserved in the error message text from `classifyConnectErr` but is no longer a top-level field.

### Decision 5: No stack traces in `trigger.exception` payloads

`InvocationEventError.stack` remains optional in the type (it's optional today). Pre-dispatch error payloads carry `error: {message}` only — no stack. Rationale:

- Stack traces from `imapflow` / `cron-parser` internals leak engine implementation detail to workflow authors with zero actionable signal.
- Authors need to know *what* failed (`stage: "search"`) and *why* (`"NO unknown folder"`) in operator-meaningful terms, not engine call frames.
- Operators who DO need stacks have the engine-bug paths (cron / imap fire-threw) which still log via Pino with full stacks.

### Decision 6: Bare-leaf synthetic invocation (no frame wrapper)

Two options for "what does an invocation look like that never ran a handler":

- **(j)** Emit only the `trigger.exception` leaf event for a fresh `invocationId`. Invocation record builder reconstructs the record from the single event.
- **(k)** Synthesize a `trigger.request` (open) → `trigger.exception` (leaf) → `trigger.error` (close) sequence so the existing dashboard plumbing renders unchanged.

**Selected: (j)**. The `logging-consumer.ts:19-32` exclusion for `trigger.exception` is automatic (no case); under (k) we'd need to thread a "skip logging" flag through synthetic frames, defeating the reuse motivation. Plus (j) is honest: there was no request, no input, no run.

The invocation record builder learns one new shape: a single `trigger.exception` event constitutes a complete failed invocation with `input: {}`, `startedAt === completedAt === event.at`, `status: "failed"`, `error: event.payload.error`.

### Decision 7: Emission flows through `executor.fail`, not a free-floating helper

Pre-dispatch events have neither sandbox nor RunSequencer. Two structural questions: (1) where does stamping happen, and (2) what abstraction does the `TriggerSource` see?

**(1) Stamping location.** Three options were considered:

- **(m1) Runtime-only stamping helper** that the source imports and calls directly with identity fields it already holds.
- **(m2) Sequencer-with-no-run** — spin up a no-op `RunSequencer` per failure to push the leaf through.
- **(m3) `executor.fail` method** — sibling to `executor.invoke`. The executor itself does the stamping; sources never see the bus or the helper.

**Selected: (m3)**. The sequencer's job is pairing opens with closes within a frame; a leaf with no frame doesn't need one (rules out m2). The executor is already the single authority on `(owner, repo, workflow, workflowSha, invocationId)` stamping for sandbox-driven events (today's `executor.sb.onEvent` widener); extending it to a no-sandbox path keeps that authority intact. The internal stamping primitive (`createTriggerExceptionEmitter`) is kept as the executor's *internal* helper — the single chokepoint where SECURITY.md R-8's carve-out is enforced via `assertTriggerExceptionKind`.

**(2) Source-facing abstraction.** The `TriggerSource` contract (`packages/runtime/src/triggers/source.ts:16`) is explicit: *"Backends never touch the Executor — they invoke `entry.fire(input)`."* Handler dispatch already follows the pattern: the `WorkflowRegistry` builds a per-trigger `fire` closure via `buildFire(executor, owner, repo, workflow, descriptor, …)` and attaches it to `TriggerEntry`; the source only sees `entry.fire(input)`. Failure dispatch should mirror this exactly:

- A new `buildException(executor, owner, repo, workflow, descriptor)` factory (sibling to `build-fire.ts`).
- A new `entry.exception(params)` field on `TriggerEntry`. `params` carries `{ name, error, details? }` — the failure-category discriminator and stage-specific payload are call-time, identity is build-time. Mirrors `buildFire`'s split.
- The IMAP source calls `entry.exception({ name: "imap.poll-failed", … })`; it has no `bus` reference, no executor reference, no stamping primitive reference.

This rejects an earlier draft (a runtime-composition-root `TriggerExceptionEmitter` injected into `createImapTriggerSource`) on the grounds that it would let a `TriggerSource` emit directly onto the bus — exactly the architectural break the existing source/registry contract was written to prevent.

R-8's stamping-boundary section gains a fourth layer: "Runtime-stamped (host-side, in `executor.fail`, no sandbox involved): all of `id`, `kind`, `name`, `seq=0`, `ref=0`, `ts=0`, `at`, plus `owner`/`repo`/`workflow`/`workflowSha`/`invocationId`. **For `trigger.exception` ONLY.**"

### Decision 8: Inline dashboard rendering, not a separate panel

The synthetic-invocation `(j)` shape lets the existing invocations list render `trigger.exception` entries inline with one renderer change keyed on `event.kind === "trigger.exception"`. A separate "Trigger health" panel would need a new route, new query plumbing, and a second cognitive surface for authors. Rejected.

Visual distinction: distinct icon (e.g. wrench/settings for "setup failed" vs. red ✗ for handler-throw). Single-leaf invocations carry no `result` and a synthetic `input: {}`; the renderer skips the input/output sub-rows.

### Decision 9: HTTP triggers stay silent on caller-driven failures

HTTP body parse / Zod validation failures are caller-driven: an external caller posts garbage. The author's recourse is to fix the schema or document the API; the engine's recourse is to return 4xx. Surfacing every malformed POST as a dashboard event is:

- Redundant — the response code already tells the caller.
- DoS-able — `/webhooks/*` is public (SECURITY.md §3); anyone on the internet can flood an author's invocation list with one synthetic invocation per request.
- Inconsistent with the "author can fix this" criterion — authors can't fix arbitrary external garbage.

HTTP is therefore out of scope for this change. No `http.ts` modifications.

## Risks / Trade-offs

```
[Risk] Dashboard flooding from a broken IMAP server                     ──► [Mitigation]
       Misconfigured IMAP host produces one trigger.exception per           Per-cycle (β) aggregation;
       poll cycle (~once per minute by default). Over a day that's          poll interval is the
       ~1440 entries per broken trigger.                                    natural rate limiter.
                                                                            Authors will notice
                                                                            within the first poll
                                                                            and fix or disable.

[Risk] Single-leaf invocation breaks existing dashboard list query     ──► [Mitigation]
       The dashboard list query may assume every invocation has a           Add explicit handling
       trigger.request event.                                               in the invocation
                                                                            record builder; covered
                                                                            in tasks.md and tested.

[Risk] EventStore / DuckDB index behavior on the new kind              ──► [Mitigation]
       Adding a new EventKind may need an index update.                     Verify in PR1: the
                                                                            current index keys on
                                                                            (tenant, repo,
                                                                            invocationId), not on
                                                                            kind. Likely no schema
                                                                            change.

[Risk] R-8 stamping boundary expansion is reviewed carefully           ──► [Mitigation]
       The runtime now stamps sandbox-owned scalars (seq/ref/ts/at/id)      Single chokepoint
       on this one kind. Future contributors might extend the path          (executor.fail's
       to other kinds, eroding the R-8 invariant.                           internal stamping
                                                                            primitive); R-8
                                                                            update says
                                                                            "trigger.exception
                                                                            ONLY"; the primitive
                                                                            asserts on kind to
                                                                            prevent extension.

[Risk] Spec says trigger.error with reason; we are emitting            ──► [Mitigation]
       trigger.exception with stage. Spec consumers (if any                 Modified imap-trigger
       external) break.                                                     spec is part of this
                                                                            change. No external
                                                                            consumers exist (spec
                                                                            is internal to this
                                                                            repo).

[Risk] β.2 emission rate could still be too noisy if a tenant          ──► [Mitigation]
       has many imapTriggers, each polling every minute, all                None at the engine
       broken simultaneously.                                               level — this is a
                                                                            tenant-level concern,
                                                                            and the dashboard list
                                                                            paginates. Future work
                                                                            (out of scope) could
                                                                            add per-trigger
                                                                            collapse in the UI.
```

## Migration Plan

The change splits into two PRs.

**PR1: introduce `trigger.exception` kind + `executor.fail` + `buildException` + `TriggerEntry.exception` + dashboard.**

1. Add `"trigger.exception"` to `EventKind` in `packages/core/src/index.ts`.
2. Add `executor.fail(owner, repo, workflow, descriptor, params)` to `packages/runtime/src/executor/index.ts`, with its internal stamping primitive. The primitive hard-codes `kind: "trigger.exception"` and asserts on it.
3. Add `buildException` factory at `packages/runtime/src/triggers/build-exception.ts` (sibling to `build-fire.ts`).
4. Extend `TriggerEntry` (`packages/runtime/src/triggers/source.ts`) with `readonly exception: (params) => Promise<void>`.
5. Update `WorkflowRegistry` to call `buildException` alongside `buildFire` for every constructed `TriggerEntry`.
6. Extend the dashboard's invocation-list query to surface single-leaf `trigger.exception` synthetic invocations as `failed` rows (no central record builder; `UNION ALL` against the existing trigger.request-driven query).
7. Add dashboard renderer keyed on `kind === "trigger.exception"`.
8. Update SECURITY.md R-7 (enumerate the `trigger.*` family kinds explicitly) and R-8 (four-layer stamping boundary, with the new layer scoped to `trigger.exception` only).
9. Spec deltas (auto-applied at archive): `invocations`, `logging-consumer`, `dashboard-list-view`.

After PR1 merges, the kind exists, every `TriggerEntry` has `.exception`, but no source calls it yet. Existing behavior unchanged.

**PR2: rewrite IMAP poll loop to use the per-cycle aggregator.**

1. Replace the six per-call-site `logger.warn`/`logger.error` calls in `packages/runtime/src/triggers/imap.ts` with an in-flight failure accumulator (per `runPoll()` invocation).
2. At end of `runPoll()` (in the `finally`), if the accumulator is non-empty, call `srcEntry.entry.exception({ name: "imap.poll-failed", error, details: { stage, failedUids } })`.
3. Keep `logger.error("imap.fire-threw")` (engine bug, no event).
4. The IMAP source has no `bus` / executor / stamping reference — it only calls `entry.exception(...)`, mirroring `entry.fire(...)`.
5. Update `imap-trigger` spec delta (replace "Error taxonomy" with the new shape and scenarios).

**Rollback strategy.** Each PR is independently revertable. Reverting PR2 puts IMAP back on Pino logs (current state). Reverting PR1 also reverts PR2 (PR2 depends on PR1's helper and kind). No persistence migration is involved — events written under either PR are append-only and the dashboard's renderer either knows the kind or doesn't (unknown kinds render as a generic "unknown event" today).

**Cron is not migrated** in either PR. Cron's failure paths remain `logger.error` only.

## Open Questions

None. All design decisions resolved during exploration. If implementation surfaces new questions, capture them in the PR description and update this doc.
