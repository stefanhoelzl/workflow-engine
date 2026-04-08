## Context

RuntimeEvent currently uses a flat 5-value `state` enum (`pending | processing | done | failed | skipped`). Terminal-state detection is duplicated in consumers: persistence.ts checks `state === "done" || state === "failed" || state === "skipped"`, work-queue.ts uses `state !== "pending"`. The `error` field is loosely coupled — optional on all events by convention, only populated on `failed`.

The type system does not distinguish terminal from active events, nor enforce that `error` accompanies failure.

## Goals / Non-Goals

**Goals:**
- Encode terminal semantics in the RuntimeEvent type: `state === "done"` is the single terminal check
- Separate lifecycle progress (`state`) from outcome (`result`)
- Enforce `error` presence on failed events at the schema level
- Enable TypeScript narrowing: checking `state` gives `result`, checking `result === "failed"` gives `error`

**Non-Goals:**
- Migrating existing archived event files on disk (append-only, never re-parsed)
- Changing the sandbox API surface (`ctx.data`, `ctx.emit`) — this is internal to the runtime
- Adding a type guard function — `event.state === "done"` is sufficient for TS narrowing

## Decisions

### Decision 1: Split state into state + result

**Choice:** Two fields — `state: "pending" | "processing" | "done"` for lifecycle, `result: "succeeded" | "failed" | "skipped"` for outcome (present only when done).

**Alternatives considered:**
- *Add `terminal: boolean` field*: Redundant with state — two fields encoding the same information creates sync risk.
- *Helper function `isTerminalEvent()`*: Keeps the schema unchanged but doesn't improve the type model. Consumers still see a flat enum.
- *Keep as-is with shared constant set*: Marginal improvement, still no type narrowing.

**Rationale:** The current `done` / `failed` / `skipped` states mix two orthogonal concerns. Splitting them makes the state machine self-documenting: lifecycle has 3 states, outcomes have 3 values, and their relationship is structural.

### Decision 2: Zod union of object variants

**Choice:** RuntimeEventSchema is a `z.union()` of four object shapes sharing a spread base, discriminated by `state` and `result`.

```
ActiveEvent:     { state: "pending" | "processing" }
SucceededEvent:  { state: "done", result: "succeeded" }
SkippedEvent:    { state: "done", result: "skipped" }
FailedEvent:     { state: "done", result: "failed", error: unknown }
```

**Alternatives considered:**
- *Discriminated union on state alone*: Zod's `discriminatedUnion` requires unique discriminator values per variant; multiple `"done"` variants won't work.
- *Single flat schema with `.refine()`*: Validates at runtime but TypeScript can't narrow — no compile-time enforcement.

**Rationale:** `z.union()` with literal fields gives Zod runtime validation and TypeScript compile-time narrowing from a single source of truth.

### Decision 3: Only export RuntimeEvent (the union type)

**Choice:** No named variant type exports (ActiveEvent, TerminalEvent, etc.). Consumers narrow via control flow.

**Rationale:** TypeScript narrows the union automatically when checking `event.state === "done"` — named types add export surface without enabling anything new.

### Decision 4: EventStore DDL adds result column

The DuckDB `events` table adds a nullable `result TEXT` column. The `state` column narrows to 3 values. The `toRow()` mapping function sets `result` from the event when present.

```
                 EMIT FLOW (scheduler → bus → consumers)
  ┌──────────┐    ┌──────────┐    ┌─────────────┐    ┌────────────┐
  │Scheduler │───▶│ EventBus │───▶│ Persistence │───▶│ EventStore │
  │          │    │          │    │             │    │  (DuckDB)  │
  │ emits:   │    │ fans out │    │ routes by:  │    │ stores:    │
  │ state +  │    │ to all   │    │ state=done? │    │ state +    │
  │ result   │    │ consumers│    │ → archive/  │    │ result     │
  └──────────┘    └──────────┘    │ else        │    └────────────┘
                                  │ → pending/  │
                                  └─────────────┘
```

### Decision 5: No migration of archived events

Archived event files use the old shape and are never re-parsed after bootstrap. New events written going forward use the new shape. The persistence `recover()` function reads from `pending/` which only contains active (non-terminal) events — these already have no `result` field equivalent, so no migration is needed there either.

## Risks / Trade-offs

- **Spread operator in emit sites becomes error-prone** — `{ ...event, state: "done" }` will now fail type-checking if `result` is missing, which is the desired behavior. But it means every emit call site must be updated simultaneously. → Mitigation: TypeScript compiler catches all incomplete sites; this is a single-package change.

- **Zod union parse performance** — `z.union()` tries each variant in order. With 4 variants this is negligible, but worth noting if the variant count grows. → Mitigation: The variant count is fixed by the state machine; it won't grow.

- **DuckDB schema drift** — Old rows in the EventStore (from before the change) will have `result: NULL` and `state` values like `"failed"`. This only matters for queries spanning old and new data in a single process lifetime. → Mitigation: EventStore is in-memory (DuckDB), rebuilt each process start. No persistence across restarts.
