## Context

The persistence layer writes a new file for every event state transition (pending, processing, done) to `pending/`, then fire-and-forget archives all files to `archive/` only on terminal states. This means `pending/` can accumulate multiple files per event during normal operation, requiring the recovery path to group files by eventId, deduplicate to the latest state, and use a `latest` flag on bootstrap options so WorkQueue can distinguish active events from historical archive events.

This complexity was introduced to support the EventStore (which needs historical events from `archive/` at startup). But the root cause is the write path — if `pending/` were kept clean, recovery would be trivial.

## Goals / Non-Goals

**Goals:**
- Keep `pending/` to at most 1 file per event during normal operation
- Simplify recovery to a two-phase scan (pending then archive) with no cross-directory grouping
- Replace the `latest` bootstrap flag with `pending` — a clearer name tied to directory semantics
- Handle the crash edge case (at most 2 files per event in `pending/`)

**Non-Goals:**
- Changing the EventStore's behavior or query API
- Changing the archive directory structure
- Making archive writes synchronous (they remain fire-and-forget where possible)

## Decisions

### 1. Eager archive on every non-initial state transition

**Choice:** When `handle()` writes a state file for an event that already has files in `pending/`, archive the older files immediately (fire-and-forget).

**Current behavior:** Older files accumulate in `pending/` until a terminal state triggers archive of all files.

**New behavior:**
```
handle(pending)     → write to pending/                     (first file, nothing to archive)
handle(processing)  → write to pending/, archive older      (000001 → archive/, 000002 stays)
handle(done)        → write to archive/, archive remaining  (000002 → archive/, 000003 in archive/)
```

**Rationale:** Keeping `pending/` clean at the write path eliminates the need for complex dedup in recovery. The archive operation is cheap (file renames) and already fire-and-forget.

### 2. Terminal states write directly to archive/

**Choice:** Events with state `done`, `failed`, or `skipped` are written directly to `archive/` instead of `pending/`. Any remaining files in `pending/` for that event are archived fire-and-forget.

**Rationale:** Terminal events have no reason to be in `pending/` — they represent completed work. Writing directly to `archive/` means `pending/` only contains active events.

### 3. Recovery handles at-most-2 crash case

In normal operation, `pending/` has exactly 1 file per event. But if the process crashes between writing a new file and archiving the old one, `pending/` may have 2 files for the same event. Recovery groups by eventId within `pending/`, takes the latest (highest counter), and moves older files to `archive/`.

### 4. Bootstrap flag: `pending` instead of `latest`

**Choice:** Replace `latest?: boolean` with `pending?: boolean` on bootstrap options.

- `pending: true` — batch contains active events from `pending/` directory (one per event, current state)
- `pending: false` — batch contains historical events from `archive/` directory

**Rationale:** The flag name maps directly to the filesystem structure. `latest` was an abstract concept that required understanding the dedup model. `pending` is self-documenting.

### 5. Recovery yields pending first, then archive

```
recover()
  ├── Phase 1: pending/ → dedup (crash case) → yield { pending: true }
  └── Phase 2: archive/ → read all → yield { pending: false, finished: true }
```

Pending events are yielded first so WorkQueue gets populated immediately. Archive events follow for EventStore's benefit.

## Sequence: Write path with eager archive

```
Trigger → emit { state: "pending" }
  └── Persistence.handle()
      └── write 000001_evt_abc.json → pending/

Scheduler → emit { state: "processing" }
  └── Persistence.handle()
      ├── write 000002_evt_abc.json → pending/
      └── archive 000001_evt_abc.json → archive/  (fire-and-forget)

Action done → emit { state: "done" }
  └── Persistence.handle()
      ├── write 000003_evt_abc.json → archive/  (terminal → direct to archive)
      └── archive 000002_evt_abc.json → archive/  (fire-and-forget)

Result: pending/ = empty, archive/ = [000001, 000002, 000003]
```

## Sequence: Recovery with crash case

```
Crash between write and archive:
  pending/  000001_evt_abc.json (pending)
            000002_evt_abc.json (processing)   ← written, archive of 000001 didn't complete

recover()
  1. Scan pending/
     - Group by eventId: { evt_abc: [000001, 000002] }
     - Take latest: 000002 (processing)
     - Move 000001 → archive/
  2. Yield { events: [evt_abc/processing], pending: true }
  3. Scan archive/
     - Read 000001_evt_abc.json
  4. Yield { events: [evt_abc/pending], pending: false, finished: true }
```

## Risks / Trade-offs

- **[More archive operations at runtime]** Every non-initial state transition now triggers an archive. → *Mitigation:* Archive is fire-and-forget file renames — negligible cost. The current approach already does this for terminal states.

- **[Archive failure on non-terminal states]** If archiving older files fails (e.g., disk full), `pending/` may have 2 files for an event during normal operation. → *Mitigation:* Same fire-and-forget error logging as today. Recovery handles the 2-file case regardless.

- **[Breaking change to bootstrap options]** `latest` → `pending` requires updating all consumers. → *Mitigation:* All consumers are internal to the runtime package. No external API impact.
