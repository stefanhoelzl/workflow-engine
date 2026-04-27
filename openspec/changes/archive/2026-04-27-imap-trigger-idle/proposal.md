## Why

The IMAP trigger today opens a fresh TCP/TLS connection every 60 s, runs the author's UID SEARCH, dispatches matches, and disconnects. Mail-arrival latency is ~30 s on average and ~60 s worst-case; ~1440 reconnects/day per trigger is unfriendly to mailbox providers that rate-limit or ban frequent reconnects. RFC 2177 IDLE solves both: a held connection delivers `EXISTS` pushes within ~16 ms (verified against hoodiecrow in spike), and one persistent socket per trigger replaces the reconnect churn.

## What Changes

- Replace the per-cycle open-poll-close lifecycle in `packages/runtime/src/triggers/imap.ts` with a persistent connection per `(owner, repo, workflow, trigger)`. The `setTimeout` that today re-arms a fresh connection becomes a connection-state-machine `reconnectTimer` that fires on disconnect.
- Unify both modes under a single main loop: `while (!disposed) { await wakeup.next(); await drain(); }`. The mode-specific behavior is encapsulated in a `Wakeup` interface with two implementations — `PollWakeup` (60 s timer) and `IdleWakeup` (`client.idle()` + dirty-flag race handling). The mid-drain EXISTS race becomes internal to `IdleWakeup`; the main loop has no `do/while`.
- Add a new optional `mode: "poll" | "idle"` field to `ImapTriggerDescriptor` (and the SDK `imapTrigger({...})` factory). **Default `"idle"`.** The field selects which `Wakeup` factory the source uses for that entry; everything else (drain, reconnect, post-connect drain, exception aggregation) is shared.
- **No safety-net poll timer under `mode: "idle"`** — recovery from missed pushes relies on the reconnect path's post-connect drain.
- All errors recoverable with a single exp backoff curve: `60 s → 60 min` (extended from today's 15 min cap, ~4× quieter during long outages). Auth failures, missing IDLE capability under `mode: "idle"`, mailbox-not-found, search-rejected, and TCP errors all route through the same reconnect path. No DEAD terminal state.
- `trigger.exception` aggregation rule changes from "≤1 per `runPoll()`" to "≤1 per **drain**" (one execution of `await drain()` between two `await wakeup.next()` calls). When a dirty-triggered immediate re-drain runs, that's a separate `drain()` call from the loop's perspective with its own ≤1 exception. Each failed reconnect attempt also emits its own exception; the natural exp-backoff cadence is the only throttling.
- Disposition execution remains awaited per-UID before the next UID's fetch; `await drain()` does not return until the last UID's disposition has its server-side tagged response, so the loop's next `wakeup.next()` and subsequent SEARCH cannot run before the prior drain's dispositions are committed. This guarantees `UNSEEN`-style searches see disposition effects from the prior drain.
- Cold-start gap recovery: every successful `connect()` (including reconnects) is followed by a post-connect drain before entering the mode-specific wait state, so messages that arrived during the disconnect window are not missed.
- **BREAKING (out-of-tree consumers only).** Pino log lines for transport-layer failures continue to flow through `entry.exception` per the 2026-04-26 trigger-exception-event-kind change; no Pino-name changes. Consumers that match on `kind === "trigger.exception"` are unaffected.
- **Behavior change on rebuild for existing IMAP-trigger users.** Default `mode: "idle"` means tenants who upload after this change ships will silently switch from poll to IDLE on IDLE-capable servers. Authors on IDLE-less servers must set `mode: "poll"` explicitly or accept the steady stream of `trigger.exception` events the reconnect loop will produce.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `imap-trigger`: connection lifecycle changes from per-cycle ephemeral to persistent; new `mode` field on the descriptor; per-cycle exception aggregation rule restated as per-drain-pass; backoff cap extended; cold-start drain and dirty-flag re-drain semantics added.

## Impact

- **Code**: `packages/runtime/src/triggers/imap.ts` (~300–500 LOC delta — new state machine, IDLE driver, dirty-flag loop, capability check, extended backoff). `packages/runtime/src/triggers/imap.test.ts` (new test cases for poll-mode persistence, IDLE dispatch, mid-drain race, EXPUNGE filtering, post-connect drain).
- **APIs**: SDK `imapTrigger({...})` gains optional `mode` field; manifest schema in `packages/core` adds the field; runtime descriptor type adds the field. All optional with safe default.
- **Dependencies**: No new packages. Uses existing `imapflow` 1.3.2 IDLE support (verified by spike).
- **Systems**: Per-trigger persistent TCP connection lifetime increases from ~5 s (poll cycle) to potentially indefinite. Operators of mailbox providers with per-account connection caps need to be aware (one connection per `(owner, repo, workflow, trigger)`, no pooling).
- **Migration**: Additive at author level. No state wipe. CLAUDE.md upgrade-notes entry will document the default-mode behavior change and the extended backoff cap.
- **Spike artifacts**: `scripts/spike-imap-idle*.mjs` (3 files) retained as reference for the implementer; can be removed after PR 2 lands.
