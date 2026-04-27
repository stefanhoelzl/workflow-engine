## Context

The IMAP trigger today (`packages/runtime/src/triggers/imap.ts`, ~836 LOC) opens a fresh `ImapFlow` connection on every poll cycle: connect → SELECT → UID SEARCH → for-each-UID(fetch + dispatch + dispositions) → LOGOUT, every 60 s with exp backoff up to 15 min on transport-level failures. State lives in a `setTimeout`-driven entry per `(owner, repo, workflow, trigger)`. The recent (2026-04-26) trigger-exception-event-kind change unified per-stage failures into one `entry.exception(...)` call per `runPoll()`.

Two motivations push us toward RFC 2177 IDLE:

1. **Latency.** Average mail-arrival latency is ~30 s, worst-case 60 s. A spike against hoodiecrow + imapflow's IDLE driver delivered an `EXISTS` push 16 ms after a second client APPENDed. Real-world latency on Dovecot/Gmail is in the same order of magnitude — sub-second is achievable.
2. **Connection churn.** ~1440 reconnects per trigger per day, multiplied by every IMAP-trigger workflow in a tenant, is unfriendly to mailbox providers (some rate-limit, some ban accounts that thrash). One held connection per trigger eliminates this.

The library (`imapflow` 1.3.2, already on disk) supports IDLE natively. Hoodiecrow (the test server) supports IDLE via its plugin (already enabled in `imap.test.ts:96`).

## Goals / Non-Goals

**Goals:**
- Sub-second mail-arrival latency on IDLE-capable servers.
- Eliminate per-cycle reconnect churn.
- Preserve every author-visible contract: `ImapMessage` shape, disposition envelope, sentinel resolution, error model. The only new surface is the optional `mode` field.
- Keep the test surface stable: existing 13 cases must pass under `mode: "poll"`; add IDLE-specific cases without rewriting the existing harness.
- Single proposal, two PRs (persistent-conn refactor → IDLE driver) for review-size containment.
- Avoid silent message loss in any failure mode (mid-drain APPEND, disconnect-during-drain, cold start, post-reconnect gap).

**Non-Goals:**
- Connection pooling (across triggers, workflows, or owners). Each trigger holds its own connection. Authors are responsible for not exhausting per-account connection caps.
- A "fetch the announced UID directly" opt-out that bypasses the author's SEARCH. The author's SEARCH is the source of truth on every drain.
- A safety-net poll timer under `mode: "idle"`. The reconnect path (with post-connect drain) is the only recovery mechanism.
- A DEAD terminal state for unrecoverable errors (auth failure, missing IDLE capability). All errors recoverable via exp backoff; authors fix configuration by redeploying.
- Per-UID failure memory or loop detection inside the runtime. A search-disposition mismatch that causes a UID to be re-fired forever is the author's problem to detect via `trigger.exception` event volume.
- Workflow-author-visible `EXPUNGE` or `FLAGS` event surface. Only `EXISTS` (count increase) is interpreted as "potentially new matches" and triggers a re-drain.
- A demo workflow exercising IMAP. `pnpm dev` does not run a local IMAP server; demo coverage stays at the test-harness level.

## Decisions

### D1. Unified main loop with a swappable `Wakeup` driver

The persistent connection makes both modes structurally identical except for "what blocks until it's time to drain again?" That single concern is encapsulated in a `Wakeup` interface; the main loop is mode-agnostic.

```
   ┌──────────────────────────────────────────────────────────┐
   │  Per entry, one persistent connection, one main loop:    │
   │                                                          │
   │    setupConnection()        ← connect, listener-before-  │
   │       includes post-connect    SELECT, post-connect      │
   │       drain (D4)               drain                     │
   │                                                          │
   │    while (!disposed):                                    │
   │      await wakeup.next()    ← MODE-SPECIFIC              │
   │      await drain()          ← shared (D6, D7)            │
   │                                                          │
   │    on close / error / non-recoverable failure:           │
   │      emit trigger.exception (D9), schedule reconnect     │
   │      via exp backoff (D8). On reconnect success →        │
   │      back to setupConnection().                          │
   └──────────────────────────────────────────────────────────┘
```

The `Wakeup` interface:

```ts
interface Wakeup {
  // Block until the loop should drain again.
  // Implementations are responsible for capturing
  // wake-up signals that arrive during the caller's
  // drain so that mid-drain events produce an
  // immediate next() return on the following call.
  next(): Promise<void>
  dispose(): void
}
```

Two implementations:

**`PollWakeup(intervalMs = 60_000)`** — `next()` resolves after `setTimeout(intervalMs)`. No mid-drain capture is needed: a timer that elapses while drain is running just means the next `next()` call returns after another `intervalMs` from drain-completion. (Equivalent to today's behavior: re-arm-after-drain, not fixed wall-clock cadence.)

**`IdleWakeup(client)`** — registers `client.on("exists", ...)` once at construction (lives across drains). The handler sets an internal `dirty` flag and resolves any pending `next()` Promise. `next()` reads dirty atomically with installing the resolver:

```
async next() {
  await new Promise<void>(resolve => {
    pendingResolve = resolve
    if (dirty) { dirty = false; resolve() }   // already-set short-circuit
  })
  // start IDLE so the server can push EXISTS;
  // any subsequent drain command auto-breaks it.
  void client.idle()
}
```

The dirty-flag race semantics ("EXISTS arriving during drain", "EXISTS arriving in the microsecond between dirty-check and resolver-install") are entirely internal to `IdleWakeup`. The main loop sees them as "the next `next()` returned immediately."

**Why one loop, not two:** `mode: "poll"` and `mode: "idle"` differ only in their wakeup source. Drain, post-connect drain, reconnect, exception aggregation, and capability handling are identical. Encapsulating the wakeup in an interface collapses the spec and the implementation to one shape; the dirty-flag re-drain disappears as an explicit construct because it's an emergent behavior of `IdleWakeup.next()`.

**Alternatives considered:**
- Two completely separate drivers (`PollDriver`, `IdleDriver`) sharing only types. Rejected: duplicates ~200 LOC of connect/reconnect/dispose, doubles the test surface, drifts apart over time.
- A `do { dirty = false; drain(); } while (dirty)` pattern in the IDLE branch with an explicit reset-before-search ordering rule (the prior version of this design). Rejected in favor of the unified loop because the dirty-flag handling is purely internal to "what the wakeup yields"; bleeding it into the main loop adds a control structure (`do/while`) that exists for one mode only.
- Pure event-driven model with no `ready` state. Rejected: harder to reason about, harder to test deterministically.

**Testability win:** `Wakeup` is an injectable interface. Unit tests for the main loop can use a `TestWakeup` with a `triggerNow()` method, deterministically driving drain cycles without timer or hoodiecrow timing. Real `IdleWakeup` is exercised by a smaller set of integration tests against hoodiecrow that verify the EXISTS-to-`next()` plumbing.

### D2. `mode: "poll" | "idle"`, default `"idle"`

A new optional descriptor field. Three reasons to prefer the explicit field over inferring from server capability:

- An author may want `"poll"` even on an IDLE-capable server (e.g. corporate firewall that drops long-lived connections).
- Inferring from CAPABILITY is a hidden behavior that surprises authors when a server's capability response varies.
- Default `"idle"` matches the migration intent: most modern IMAP servers support IDLE, and the upgrade should "just work" on rebuild.

**Alternatives considered:**
- Boolean `idle: true | false`. Rejected: forecloses future modes (e.g. `"idle-with-fallback-poll"` if real-world data shows we need it).
- No field, always IDLE, fall back to poll if CAPABILITY lacks IDLE. Rejected: hides server misbehavior; authors lose visibility into whether their mail is push-driven or polled.
- Default `"poll"` to preserve today's behavior verbatim. Rejected: loses the upgrade story; most authors would never opt in.

### D3. Listener-before-SELECT is structural, not conventional

`setupConnection()` is a single helper that always runs `connect → on("exists") → mailboxOpen → post-connect drain` in that exact order. Future maintainers cannot reorder without rewriting the helper.

**Why not a code comment:** Comments rot. The cold-start race (EXISTS arriving during SELECT round-trip) is silent if the listener is registered late — there is no test that would obviously catch it (the post-connect drain would mask it for any message that landed before SELECT). Encoding the order in a single helper is the cheapest way to make the invariant unbreakable.

### D4. Post-connect drain on every connect

Every successful `connect()` (cold start, reconnect after drop, reconnect after backoff) is immediately followed by a drain pass before the connection enters its mode-specific wait state. This closes the gap window during which IDLE pushes were not observable. The author's UID SEARCH is the gap-recovery mechanism; the runtime maintains no UID watermark, no last-EXISTS count, no per-trigger persistence across restarts.

**Why this works:** A SEARCH like `UNSEEN` (or `SINCE today` with author-controlled state) automatically picks up anything that arrived during the disconnect window AND still matches the predicate. Authors who want at-most-once-after-recovery semantics use `\Seen`-flag dispositions; authors who want at-least-once handle dedup themselves.

### D5. Mid-drain EXISTS race is internal to `IdleWakeup`

The `IdleWakeup` driver owns the dirty-flag mechanism. The main loop has no `do/while` and no explicit reset-before-search ordering — it just calls `await wakeup.next(); await drain()` repeatedly. EXISTS events arriving during drain are captured by the connection-level `client.on("exists", ...)` listener (registered once at `setupConnection`), which sets `IdleWakeup.dirty = true` and resolves any in-flight `next()` Promise. The next iteration of the main loop calls `next()` again, which short-circuits if dirty is already set:

```ts
// inside IdleWakeup
async next() {
  await new Promise<void>(resolve => {
    pendingResolve = resolve
    if (dirty) { dirty = false; resolve() }   // capture pre-arrived signal
  })
  void client.idle()
}
```

The order — `pendingResolve = resolve` BEFORE the `if (dirty)` re-check — is the load-bearing correctness invariant. It closes a microsecond-scale race between the dirty-check and the resolver-install: if EXISTS arrives in that gap, the listener finds `pendingResolve` already set and resolves immediately; if EXISTS arrived before `next()` was called, the `if (dirty)` short-circuit catches it. Either way, no event is lost.

**Spike confirmed (`scripts/spike-imap-idle-race.mjs`):** APPEND during a 200 ms simulated drain produced an EXISTS event at `idling: false` (because the drain had broken IDLE), but the event was still delivered to the client-level listener. Under the unified loop, the listener sets dirty; the next `wakeup.next()` returns immediately; drain runs again. Functionally equivalent to the prior `do/while` formulation, with the race semantics encapsulated rather than spread across the main loop.

### D6. Disposition serialization invariant

Within a drain, dispositions are awaited per-UID before the next UID's fetch (today's behavior, unchanged). Across drains, the main loop's `await drain()` does not return until the last UID's disposition has its server-side tagged response, and `wakeup.next()` runs only after `drain()` returns. So the next drain's SEARCH cannot be issued before the prior drain's last disposition is committed. This guarantees `UNSEEN`-style searches see disposition effects from the prior drain.

**Why it matters:** If drain N marks UID 7 `\Seen` and drain N+1's SEARCH `UNSEEN` is issued before the STORE response is committed, UID 7 re-matches and fires again. imapflow's `messageFlagsAdd`/`messageMove` Promises resolve on tagged response (= server-side commit signal), so awaiting them is sufficient; we do not need an extra fence.

### D7. EXISTS-only sets dirty; EXPUNGE and FLAGS do not

`EXISTS` is the only signal that means "potentially new mail." `EXPUNGE` (mailbox count decreased) and `FLAGS` (flag mutation on existing mail) are state changes to messages we may have already seen — they don't introduce new SEARCH matches. Routing them through dirty would cause unnecessary drains, especially under `mode: "idle"` where our own dispositions can produce these events.

### D8. All errors recoverable, exp backoff 60 s → 60 min

Any error during connect, capability check, mailbox open, search, drain, or IDLE — including IMAP `NO`/`BAD` responses, missing IDLE capability under `mode: "idle"`, auth failures, TLS failures — routes through the same recovery path: emit `trigger.exception` (subject to per-drain-pass aggregation, D9), disconnect, schedule reconnect via `nextDelay(failures) = 60 s × 2^(failures-1)` capped at 60 min. The failure counter resets to 0 on the first successful drain.

**Backoff cap extended from 15 min to 60 min** (4× quieter during long outages). Healthy operations unchanged. Recovery on first success unchanged.

**Alternatives considered:**
- Recoverable/non-recoverable taxonomy with a DEAD terminal state for auth/capability/search failures. Rejected: the "all errors recoverable, author redeploys to fix" model is simpler and the steady drip of `trigger.exception` events during misconfig is itself the diagnostic signal.
- Throttling exception emission per-error-type. Rejected: the natural exp-backoff cadence already provides a ~25 events/day ceiling during a 24h sustained outage at the new 60 min cap.

### D9. Exception aggregation: per-drain

The 2026-04-26 trigger-exception-event-kind change established "≤1 `trigger.exception` per `runPoll()`" with stage-aware aggregation. Under the unified loop, `runPoll()` no longer exists — its replacement is one execution of `await drain()` between two `await wakeup.next()` calls. We aggregate at that boundary: one drain = ≤1 exception aggregating that drain's stage failures (connect, select, search, fetch×N, disposition×N). When a dirty-triggered immediate re-drain runs, that's a separate `drain()` call from the loop's perspective with its own ≤1 exception. So a 3-drain dirty cycle with failures in drains 1 and 3 emits 2 exceptions.

Reconnect-attempt failures are separate from drain failures and emit one exception per attempt with no extra throttling beyond the exp-backoff cadence.

### D10. Two-PR rollout

PR 1 lands the persistent-connection refactor + the unified main loop + the `Wakeup` interface + `PollWakeup` + the `mode` field accepted on the descriptor. `mode: "idle"` is silently routed to `PollWakeup` for now, with a `logger.info("imap.idle-pending")` line so authors' early uploads aren't surprises. PR 2 adds `IdleWakeup` (single new module) + the capability check in `setupConnection` + the wiring that selects `IdleWakeup` when `mode === "idle"`, and removes the pending-log.

This split is naturally clean because the unification confines PR 2's diff to: one new file (`idle-wakeup.ts`), one capability check, one `mode` switch in factory selection. PR 1 carries the bulk of the connection-lifecycle work and ships the abstraction; PR 2 is a focused additive change that doesn't touch the main loop.

**Alternatives considered:**
- Single PR for everything. Rejected: 500+ LOC delta with two distinct concerns is harder to review than two smaller PRs.
- Three PRs (persistent-conn, then field, then IDLE). Rejected: middle PR has nothing to verify; field-without-driver has no test surface.

## Risks / Trade-offs

[**Behavior change on rebuild for existing IMAP-trigger users.**] Default `mode: "idle"` means tenants who upload after PR 2 lands silently switch from poll to IDLE. → Document in CLAUDE.md upgrade-notes; the behavior-change is improvement (lower latency, fewer reconnects); authors on IDLE-less servers see a steady stream of `trigger.exception` and can opt into `"poll"`.

[**Search-disposition inconsistency causes tight loop under IDLE.**] If author SEARCH = `UNSEEN` and disposition fails to mark `\Seen`, the message stays UNSEEN; under IDLE, every EXISTS push (or stale dirty flag) re-fires it. → Spec documents the hazard explicitly; runtime maintains no per-UID failure memory; the loud `trigger.exception` stream IS the diagnostic.

[**Per-account connection cap exhaustion.**] Mailbox providers commonly cap concurrent connections per account (Gmail: 15, Fastmail: 30, etc.). A tenant with N triggers all pointing at one account holds N connections. → Documented in spec as author responsibility; no pooling layer (would compromise IDLE-per-folder semantics and complicate reconfigure). Operators can monitor per-trigger connection state via the existing event stream.

[**Server lies about IDLE capability.**] Some servers advertise IDLE in CAPABILITY but reject the IDLE command, or accept it but never push EXISTS. → Reject case: the IDLE command failure routes through the standard error path → reconnect with backoff. Never-push case: indistinguishable from "no mail" from the runtime's view; author observes via missing dispatches and switches to `mode: "poll"`.

[**Long-lived connection holds memory longer than ephemeral cycles.**] Per-trigger `ImapFlow` instance + libuv socket handle now lives for the trigger's lifetime instead of ~5 s per cycle. Roughly: ~50 KB per held connection vs. ~50 KB allocated/freed per cycle. → Acceptable; modern Node memory profile dominated by other surfaces.

[**Hoodiecrow leniency masks broken implementations in tests.**] The race spike showed hoodiecrow keeps pushing EXISTS even when `idling: false`, where Dovecot/Gmail would go silent. → Test I-4 explicitly asserts the re-IDLE path (append → drain → append → second EXISTS observed) by counting events that arrive AFTER an explicit `client.idle()` re-arm; a missing re-idle would still be caught because hoodiecrow emits in both states (the test asserts the call to `client.idle()` was made between drains, not just that the event arrived).

## Migration Plan

PR 1 (persistent connection + field acceptance):
- Deploy to staging; verify existing IMAP triggers still dispatch on the 60 s cadence with the same author-visible contract.
- No author rebuild required; the new `mode` field defaults to `"idle"` but routes to poll behavior pending PR 2 (`logger.info("imap.idle-pending")` per entry on first connect).
- Rollback: revert PR. State persistence is unaffected (no event schema changes).

PR 2 (IDLE driver):
- Deploy to staging; observe a known IMAP-trigger workflow's latency drop from ~30 s avg to <1 s on staging mailbox.
- Verify exception stream during induced failures (kill IMAP server, invalid credentials) shows the expected per-drain-pass + per-reconnect-attempt cadence.
- Tenants pick up IDLE behavior on next `wfe upload` (no force-rebuild required for existing manifests; the new field's host-side default applies even to manifests that omit it).
- CLAUDE.md upgrade-notes entry lands with PR 2.
- Rollback: revert PR. Tenants automatically fall back to poll-via-persistent-connection behavior; their manifests' default `mode: "idle"` value is harmless (still routes to poll).

## Open Questions

None. All four interview threads (exception aggregation, error recovery, cold-start race, disposition failure) resolved before this design was written. Spike retired the IDLE-driver risk.
