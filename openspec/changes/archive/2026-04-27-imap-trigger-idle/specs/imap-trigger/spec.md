## MODIFIED Requirements

### Requirement: imapTrigger factory creates branded ImapTrigger

The SDK SHALL export an `imapTrigger(config)` factory that returns an `ImapTrigger` value that is BOTH branded with `Symbol.for("@workflow-engine/imap-trigger")` AND callable as `(msg: ImapMessage) => Promise<ImapTriggerResult>`. Invoking the callable SHALL run the user-supplied `handler(msg)` and return its result.

The config SHALL require:
- `host`: string — IMAP server hostname.
- `port`: number — IMAP server port.
- `tls`: `"required" | "starttls" | "none"` — transport mode. Default `"required"` (IMAPS).
- `user`: string — login identity.
- `password`: string — login credential.
- `folder`: string — mailbox folder to `SELECT`. Typical value is `"INBOX"`.
- `search`: string — raw IMAP `SEARCH` criteria passed to `UID SEARCH` verbatim.
- `handler`: `(msg: ImapMessage) => Promise<ImapTriggerResult>` — async handler invoked per matched message.

The config SHALL accept optional:
- `insecureSkipVerify`: boolean — skip TLS certificate verification. Default `false`. Intended for self-signed dev servers; production deployments SHALL NOT set this.
- `onError`: `ImapTriggerResult` — disposition applied when `handler` throws or rejects. Default `{}`.
- `mode`: `"poll" | "idle"` — connection driver mode. Default `"idle"`. `"idle"` requires the server to advertise the `IDLE` capability per RFC 2177; failure to do so is treated as a recoverable error (see "Error taxonomy"). `"poll"` preserves the 60 s drain cadence on the persistent connection without using IDLE.

The returned value SHALL expose `host`, `port`, `tls`, `insecureSkipVerify`, `user`, `password`, `folder`, `search`, `mode`, `onError`, `inputSchema`, `outputSchema` as readonly own properties. `inputSchema` SHALL be the Zod schema describing `ImapMessage`. `outputSchema` SHALL be `z.object({ command: z.array(z.string()).optional() })`. The captured `handler` SHALL NOT be exposed as a public property.

#### Scenario: imapTrigger returns branded callable

- **GIVEN** `const t = imapTrigger({ host: "imap.example", port: 993, tls: "required", user: "u", password: "p", folder: "INBOX", search: "UNSEEN", handler: async () => ({}) })`
- **WHEN** the value is inspected
- **THEN** `t` SHALL be a function (callable)
- **AND** `t[IMAP_TRIGGER_BRAND]` SHALL be `true`
- **AND** `t.host`, `t.port`, `t.tls`, `t.user`, `t.password`, `t.folder`, `t.search`, `t.mode`, `t.inputSchema`, `t.outputSchema` SHALL be exposed as readonly properties
- **AND** `t.handler` SHALL NOT be defined as an own property

#### Scenario: imapTrigger default tls is 'required'

- **GIVEN** `const t = imapTrigger({ host: "h", port: 993, user: "u", password: "p", folder: "INBOX", search: "ALL", handler: async () => ({}) })` — `tls` omitted
- **WHEN** `t.tls` is inspected
- **THEN** it SHALL equal `"required"`

#### Scenario: imapTrigger default insecureSkipVerify is false

- **GIVEN** the same config with `insecureSkipVerify` omitted
- **WHEN** `t.insecureSkipVerify` is inspected
- **THEN** it SHALL equal `false`

#### Scenario: imapTrigger default onError is empty envelope

- **GIVEN** the same config with `onError` omitted
- **WHEN** `t.onError` is inspected
- **THEN** it SHALL equal `{}`

#### Scenario: imapTrigger default mode is 'idle'

- **GIVEN** `const t = imapTrigger({ ..., handler: async () => ({}) })` — `mode` omitted
- **WHEN** `t.mode` is inspected
- **THEN** it SHALL equal `"idle"`

#### Scenario: imapTrigger explicit mode poll preserved

- **GIVEN** `const t = imapTrigger({ ..., mode: "poll", handler: async () => ({}) })`
- **WHEN** `t.mode` is inspected
- **THEN** it SHALL equal `"poll"`

#### Scenario: imapTrigger callable invokes the handler

- **GIVEN** `const t = imapTrigger({ ..., handler: async (msg) => ({ command: [\`UID STORE \${msg.uid} +FLAGS (\\\\Seen)\`] }) })`
- **WHEN** `await t({ uid: 42, ...rest })` is called
- **THEN** the handler SHALL be invoked with the argument
- **AND** the return value SHALL be `{ command: ["UID STORE 42 +FLAGS (\\Seen)"] }`

### Requirement: ImapTriggerSource polling lifecycle

The runtime SHALL provide `packages/runtime/src/triggers/imap.ts` exporting an `ImapTriggerSource` implementing `TriggerSource<"imap", ImapTriggerDescriptor>`. The source SHALL hold one persistent IMAP connection per `(owner, repo, workflowName, triggerName)` for the entry's lifetime. The source SHALL:

1. On `start()`: allocate per-source state (no external connections; no timers armed).
2. On `reconfigure(owner, repo, entries)`: replace the `(owner, repo)` entry map for the `"imap"` kind in full. For removed entries: cancel any in-flight reconnect timer, close the held IMAP connection (best-effort `LOGOUT`). For added or replaced entries: schedule `setupConnection()` with delay 0 (first connect immediate).
3. `setupConnection()` for an entry SHALL execute the following steps in order, atomically with respect to event-listener registration:
   1. Construct `ImapFlow` with `host`, `port`, `secure: tls === "required"`, `auth: { user, pass: password }`, `tls.rejectUnauthorized: !insecureSkipVerify`.
   2. `await client.connect()`.
   3. If `mode === "idle"`: assert `client.capabilities.has("IDLE")`. If absent, treat as a recoverable connect-stage failure (see "Error taxonomy") and disconnect.
   4. Construct the entry's `Wakeup` (see ADDED requirement "Wakeup driver contract"): `PollWakeup(60_000)` when `mode === "poll"`; `IdleWakeup(client)` when `mode === "idle"`. `IdleWakeup` registers `client.on("exists", ...)` internally during its construction. **This step MUST happen before SELECT**, so an EXISTS arriving during the SELECT round-trip is captured by the listener that `IdleWakeup` installs.
   5. `await client.mailboxOpen(folder)`.
   6. Run the post-connect drain (one execution of the drain body — see drain definition below). This is the gap-recovery drain that closes the window during which IDLE pushes were not observable since the prior disconnect (or, on cold start, since the trigger was registered).
   7. Enter the unified main loop.
4. **Drain** is the body: `for each UID returned by UID SEARCH <search> serially: UID FETCH body[], parse via postal-mime, await entry.fire(parsedMsg) via the executor, await application of the returned ImapTriggerResult.command (or, on handler error, the trigger's onError.command)`. Dispositions SHALL be awaited per-UID before the next UID's fetch begins. The drain ends when the SEARCH-result list has been fully iterated (with per-UID failures aggregated; see "Error taxonomy") or when a fatal pre-loop stage fails.
5. **Main loop.** After `setupConnection()` completes (including its post-connect drain), the source SHALL run the unified main loop:
   ```
   while (!entry.disposed) {
     await entry.wakeup.next()
     await drain(entry, client)
   }
   ```
   The loop body is mode-agnostic. The mid-drain EXISTS race semantics (EXISTS arriving during a drain produces an immediate next-iteration drain) are encapsulated inside `IdleWakeup.next()`. Under `mode: "poll"`, `PollWakeup.next()` resolves after `setTimeout(60_000)`. Under `mode: "idle"`, `IdleWakeup.next()` resolves on the next `EXISTS` event (or immediately if one arrived during the prior drain).
6. The source SHALL register `client.on("close")` and `client.on("error")` handlers that, on first invocation, dispose the entry's `Wakeup`, transition the entry to `disconnected`, and schedule a reconnect via `setTimeout(nextDelay(failures))`, where `nextDelay(0) = 60_000` and `nextDelay(n>0) = min(60_000 × 2^(n-1), 3_600_000)` (60 s base, 60 min cap). The failures counter SHALL increment on every recoverable error and reset to 0 on the first successful drain after reconnect.
7. In-flight drain re-entry SHALL NOT occur within a single entry: the main loop awaits `drain()` fully before calling `wakeup.next()` again.
8. On `stop()` (or removed-entry teardown via `reconfigure`): set `entry.disposed = true`, dispose the `Wakeup` (cancels any pending `next()` Promise), cancel all reconnect timers, and close any open connection (best-effort `LOGOUT`).

The source SHALL use the `imapflow` library for the IMAP client and `postal-mime` for MIME parsing.

#### Scenario: Reconfigure replaces entries in full and closes connections

- **GIVEN** an `ImapTriggerSource` with a previously-registered entry for `(owner=acme, repo=billing, trigger=inbound)` holding an open IMAP connection
- **WHEN** `reconfigure("acme", "billing", [])` is called with an empty entry list
- **THEN** the source SHALL cancel any pending reconnect timer for the `inbound` trigger
- **AND** the source SHALL close the held IMAP connection (best-effort `LOGOUT`)
- **AND** no further drains SHALL fire for that entry
- **AND** other `(owner, repo)` entries SHALL be unaffected

#### Scenario: Persistent connection survives across two poll-mode drains

- **GIVEN** an `imapTrigger` with `mode: "poll"` registered against a server that accepts the connection
- **WHEN** two consecutive 60 s drain ticks fire
- **THEN** the same `ImapFlow` instance (and underlying TCP socket) SHALL be reused across both drains
- **AND** each drain SHALL run SEARCH on the already-open mailbox without re-issuing CONNECT or SELECT

#### Scenario: Post-connect drain dispatches messages that arrived during disconnect

- **GIVEN** an `imapTrigger` with `mode: "idle"` whose connection drops, then reconnects 30 s later, during which window a new message matching the SEARCH was APPENDed by another client
- **WHEN** `setupConnection()` completes
- **THEN** the post-connect drain SHALL run the author's UID SEARCH on the freshly-selected mailbox
- **AND** the message that arrived during the disconnect window SHALL be dispatched as part of the post-connect drain
- **AND** the entry SHALL transition to the IDLE wait state only after the post-connect drain completes

#### Scenario: Mid-drain APPEND triggers an immediate next drain in IDLE mode

- **GIVEN** an `imapTrigger` with `mode: "idle"` currently blocked in `IdleWakeup.next()` (i.e. `client.idle()` armed)
- **WHEN** an APPEND from another client triggers EXISTS, and during the resulting drain a SECOND APPEND triggers another EXISTS
- **THEN** the connection-level `client.on("exists", ...)` listener installed by `IdleWakeup` SHALL set `IdleWakeup`'s internal dirty flag and resolve any pending `next()` Promise
- **AND** after the in-flight drain completes (including its last disposition), the main loop's next `wakeup.next()` call SHALL return immediately (because dirty was set during drain)
- **AND** the next `drain()` call SHALL re-issue the author's UID SEARCH
- **AND** the message from the second APPEND SHALL be dispatched before the loop next blocks in `IdleWakeup.next()`

#### Scenario: EXPUNGE during drain does not trigger an extra drain

- **GIVEN** an `imapTrigger` with `mode: "idle"` in the middle of a drain
- **WHEN** an EXPUNGE event fires (a message was removed from the mailbox by another client or by the source's own UID MOVE disposition)
- **THEN** `IdleWakeup`'s dirty flag SHALL NOT be set
- **AND** after the in-flight drain returns, `wakeup.next()` SHALL block (re-arm IDLE) rather than returning immediately

#### Scenario: Disposition completion ordered before next drain's SEARCH

- **GIVEN** an `imapTrigger` with `mode: "idle"` and `search: "UNSEEN"`, where drain N marks UID 7 `\Seen` via `UID STORE`
- **WHEN** EXISTS fires during drain N, dirty is set, the main loop returns from `wakeup.next()` and starts drain N+1
- **THEN** drain N+1's SEARCH SHALL be issued only after drain N's `UID STORE` for UID 7 has received its tagged response from the server (because `await drain()` does not return until the last disposition has its tagged response)
- **AND** drain N+1's SEARCH result SHALL exclude UID 7 (consistent with the just-committed `\Seen` flag)

#### Scenario: Listener-before-SELECT invariant in setupConnection

- **GIVEN** the source code of `setupConnection()` in `packages/runtime/src/triggers/imap.ts`
- **WHEN** the order of operations is reviewed
- **THEN** `IdleWakeup` (which installs `client.on("exists", ...)`) SHALL be constructed AFTER `client.connect()` and BEFORE `client.mailboxOpen(folder)`, ensuring the listener captures any EXISTS arriving during SELECT

### Requirement: Error taxonomy

The imap source SHALL emit at most one `trigger.exception` event per **drain** (one execution of `await drain()` between two `await wakeup.next()` calls in the unified main loop) when the drain encounters one or more author-fixable failures. The event's `name` field SHALL be `"imap.poll-failed"`. The payload SHALL carry:

| field | type | meaning |
|---|---|---|
| `stage` | `"connect" \| "mailboxOpen" \| "search" \| "fetch" \| "disposition"` | The stage at which the pass failed (or, when the pass completed but had per-UID fetch failures, `"fetch"`). When multiple stages fail in the same pass, the FIRST fatal stage SHALL be reported. |
| `failedUids` | `number[]` | UIDs whose fetch (or, in the rare disposition case, disposition) failed during this pass. Empty `[]` for fatal stages reached before any UIDs were attempted (`connect`, `mailboxOpen`, `search`). For the `disposition` stage, contains the single in-flight UID. For the `fetch` stage, contains all UIDs whose fetch failed across the pass. |
| `error` | `{ message: string }` | The error's message text. SHALL NOT carry a `stack` field. For `connect` failures, the message SHALL include the connect-failure classification (auth / TLS / capability / generic) embedded in the text rather than carried as a separate top-level field. |

The imap source SHALL emit `trigger.exception` events exclusively by calling `entry.exception(params)` on the `TriggerEntry` it received via `reconfigure(owner, repo, entries)`. The source SHALL NOT import or hold a reference to the `EventBus`, the executor, or any free-floating stamping primitive — the `entry.exception` callable is the source's only outbound channel for failures, mirroring the `entry.fire(input)` callable used for handler dispatch.

A drain that completes successfully (connect, mailboxOpen, search, all fetches, all dispositions all succeed) SHALL NOT call `entry.exception`.

A drain whose pre-loop stages (`connect`, `mailboxOpen`, `search`) fail SHALL call `entry.exception` with the corresponding `stage` and `failedUids: []`. The pass aborts immediately; no UIDs are attempted; the entry transitions to `disconnected` and reconnect is scheduled via exp backoff.

A drain that reaches the per-UID loop and accumulates one or more `fetch` failures while otherwise completing SHALL call `entry.exception` with `stage: "fetch"` and `failedUids` populated, even when the pass's overall outcome is "successful" (no fatal stage). This is the β.2 emission rule.

A drain that reaches the per-UID loop and fails on `disposition` SHALL call `entry.exception` with `stage: "disposition"` and `failedUids: [<uid>]` containing the UID whose disposition failed. The pass aborts; subsequent UIDs in the batch are not dispatched (existing batch-stop semantics under disposition failure).

When a dirty-triggered immediate re-drain runs (because `IdleWakeup.next()` returned without blocking), that is a NEW `drain()` call from the main loop's perspective with its own ≤1 exception. A 3-drain dirty cycle with failures in drains 1 and 3 SHALL emit 2 `trigger.exception` events.

Each failed reconnect attempt SHALL emit its own `trigger.exception` (one per attempt; no extra throttling beyond the natural cadence imposed by the exp-backoff curve below).

All errors are recoverable. Auth failures (`NO [AUTHENTICATIONFAILED]`), missing IDLE capability under `mode: "idle"`, missing mailbox (SELECT NO), search syntax rejected (BAD), TLS handshake failures, and TCP errors all route through this same path: emit `trigger.exception`, disconnect, schedule reconnect via exp backoff. The runtime maintains no DEAD terminal state; authors fix configuration errors by redeploying.

The imap source SHALL NOT emit a separate Pino log entry for any of the per-stage failures captured by the per-pass aggregator. Pino logging for those failures (the previous `imap.connect-failed` / `imap.search-failed` / `imap.fetch-failed` / `imap.disposition-failed` lines) is REMOVED.

The `imap.fire-threw` failure mode (the registry-built `entry.fire` closure itself throws — an engine bug, not an author misconfiguration) is OUTSIDE this requirement. Such failures SHALL continue to log via Pino at `error` level and SHALL NOT emit a `trigger.exception`. Handler-throw events (the handler called inside `entry.fire` throws) continue to flow through the standard `trigger.error` path emitted by the in-sandbox trigger plugin.

Repeated reconnect failures SHALL be subject to exponential backoff: `nextDelay(failures) = 60_000 × 2^(failures-1)`, capped at 3_600_000 (60 minutes). The cap was extended from 15 minutes to 60 minutes to reduce event-stream volume during sustained outages by ~4×. The next drain cadence SHALL reset to 60 s after one fully successful drain (failures counter → 0).

#### Scenario: Connect-refused emits one trigger.exception per attempt

- **GIVEN** an `imapTrigger` whose configured server refuses TCP connections
- **WHEN** `setupConnection()` runs
- **THEN** `entry.exception` SHALL be called exactly once for that attempt, producing one `trigger.exception` event on the bus with `name: "imap.poll-failed"`, `stage: "connect"`, `failedUids: []`, `error: { message: <connect-error text> }`
- **AND** no `trigger.request`, `trigger.response`, or `trigger.error` event SHALL be emitted for the attempt
- **AND** no Pino log entry SHALL be emitted for the connect failure
- **AND** the source SHALL schedule the next reconnect via exp backoff (60 s → 60 min)

#### Scenario: Missing IDLE capability under mode:idle is a recoverable error

- **GIVEN** an `imapTrigger` with `mode: "idle"` against a server whose CAPABILITY response lacks `IDLE`
- **WHEN** `setupConnection()` reaches the capability check after a successful `connect()`
- **THEN** `entry.exception` SHALL be called exactly once with `stage: "connect"`, `failedUids: []`, `error: { message: <text containing "IDLE capability missing" or similar classification> }`
- **AND** the source SHALL disconnect and schedule reconnect via exp backoff
- **AND** subsequent reconnect attempts SHALL repeat the capability check; if the server's CAPABILITY changes (rare but possible), the next attempt SHALL succeed and enter IDLE normally

#### Scenario: Search rejected emits one trigger.exception with stage=search

- **GIVEN** an `imapTrigger` whose configured `search` string is rejected by the server with `BAD UNKNOWN_KEYWORD`
- **WHEN** a drain reaches the SEARCH stage
- **THEN** `entry.exception` SHALL be called exactly once for that pass with `stage: "search"`, `failedUids: []`, `error: { message: <imap NO/BAD response text> }`
- **AND** the pass SHALL abort before any UIDs are attempted
- **AND** the source SHALL disconnect and schedule reconnect via exp backoff

#### Scenario: Per-UID fetch failures aggregate into a single drain event

- **GIVEN** a drain that connects, opens the folder, runs SEARCH returning UIDs `[10, 20, 30, 40]`, then fails to fetch UIDs `20` and `30` while UIDs `10` and `40` succeed and dispatch normally
- **WHEN** the pass drains
- **THEN** `entry.exception` SHALL be called exactly once for that pass with `stage: "fetch"`, `failedUids: [20, 30]`, `error: { message: <one of the fetch errors> }`
- **AND** UIDs `10` and `40` SHALL produce normal `trigger.request` / `trigger.response` event pairs as separate invocations

#### Scenario: Successful drain emits no trigger.exception

- **GIVEN** a drain that connects, opens the folder, runs SEARCH returning `[]`, and exits cleanly
- **WHEN** the pass drains
- **THEN** `entry.exception` SHALL NOT be called
- **AND** no Pino log entry SHALL be emitted

#### Scenario: Disposition failure emits trigger.exception and stops the batch

- **GIVEN** a batch of 5 matching messages where the handler for message #2 (UID `22`) returns `{ command: ["UID MOVE 22 NonexistentFolder"] }` and the server responds `NO TRYCREATE`
- **WHEN** the source applies the disposition
- **THEN** `entry.exception` SHALL be called exactly once for that pass with `stage: "disposition"`, `failedUids: [22]`, `error: { message: <NO TRYCREATE text> }`
- **AND** UIDs `33`, `44`, `55` SHALL NOT be dispatched in the current pass
- **AND** the source SHALL disconnect and schedule reconnect via exp backoff (treated as a recoverable error)

#### Scenario: Dirty re-drain emits its own trigger.exception

- **GIVEN** a `mode: "idle"` entry where drain N had a `fetch` failure on UID 5, an EXISTS arrived during drain N setting `IdleWakeup`'s dirty flag, then drain N+1 (run because `wakeup.next()` returned immediately) had a `fetch` failure on UID 8
- **WHEN** the main loop completes both iterations
- **THEN** TWO `trigger.exception` events SHALL have been emitted: one for drain N with `failedUids: [5]`, one for drain N+1 with `failedUids: [8]`

#### Scenario: Each failed reconnect attempt emits its own trigger.exception

- **GIVEN** an entry whose server is hard-down and rejects 5 consecutive reconnect attempts at delays 60 s, 120 s, 240 s, 480 s, 900 s
- **WHEN** the 5 attempts complete
- **THEN** 5 `trigger.exception` events SHALL have been emitted (one per attempt) with `stage: "connect"`
- **AND** the 6th attempt SHALL be scheduled at delay 1800 s (continuing the exp curve, capped at 60 min)

#### Scenario: trigger.exception payload omits credentials

- **GIVEN** an IMAP server that responds to `LOGIN` with `NO [AUTHENTICATIONFAILED]` and the auth failure surfaces as a connect-stage error
- **WHEN** the source emits the `trigger.exception`
- **THEN** the event payload SHALL NOT contain the resolved `user` value
- **AND** the event payload SHALL NOT contain the resolved `password` value

#### Scenario: imap.fire-threw remains log-only

- **GIVEN** the registry-built `entry.fire` closure itself throws (an engine bug, not a handler bug)
- **WHEN** the source catches the throw at the `entry.fire` call site
- **THEN** a Pino `logger.error` entry SHALL be emitted with name `"imap.fire-threw"`
- **AND** `entry.exception` SHALL NOT be called for that failure

#### Scenario: Source has no bus reference

- **GIVEN** the IMAP source module's source code
- **WHEN** its imports and constructor signature are reviewed
- **THEN** it SHALL NOT import `EventBus`, the executor, or any direct stamping helper
- **AND** the only outbound channel for trigger failures SHALL be `entry.exception(params)` on each `TriggerEntry`

## ADDED Requirements

### Requirement: Wakeup driver contract

The imap source SHALL encapsulate the mode-specific "block until it's time to drain again" behavior in a `Wakeup` interface with two implementations: `PollWakeup` (selected for `mode: "poll"`) and `IdleWakeup` (selected for `mode: "idle"`). The interface SHALL expose at minimum a `next(): Promise<void>` method that resolves when the main loop SHOULD invoke `drain()` again, and a `dispose()` method that resolves any pending `next()` Promise and releases timers/listeners. Implementations MUST capture wake-up signals that arrive during the caller's drain so that mid-drain events produce an immediate next-iteration return from `next()` rather than being lost.

`PollWakeup(intervalMs)` SHALL implement `next()` as `setTimeout(intervalMs)`-backed; no mid-drain capture is required because timer expiry produces no observable event when no caller is awaiting.

`IdleWakeup(client)` SHALL register `client.on("exists", ...)` exactly once during construction. The handler SHALL set an internal `dirty` flag and SHALL resolve any in-flight `next()` Promise. `IdleWakeup.next()` SHALL be implemented so that the dirty re-check is performed AFTER the resolver is installed (i.e., inside the executor of the Promise it returns), to close the race between dirty-check and listener-fire. The handler SHALL react ONLY to `EXISTS` events; `EXPUNGE` and `FLAGS` events SHALL NOT touch dirty.

The main loop in the `ImapTriggerSource` SHALL be:

```
while (!entry.disposed) {
  await entry.wakeup.next()
  await drain(entry, client)
}
```

The main loop SHALL NOT contain any mode-specific branching. All mode-specific behavior SHALL live inside the `Wakeup` implementation selected for the entry at `setupConnection()` time.

#### Scenario: PollWakeup yields after intervalMs

- **GIVEN** a `PollWakeup(60_000)`
- **WHEN** `next()` is awaited
- **THEN** the returned Promise SHALL resolve approximately 60 s later
- **AND** repeated `next()` calls SHALL each block for `intervalMs` from the call time (not from a wall-clock reference)

#### Scenario: IdleWakeup short-circuits when EXISTS arrived during drain

- **GIVEN** an `IdleWakeup(client)` whose internal dirty flag is true (set by an EXISTS event delivered while the previous drain was running)
- **WHEN** the main loop calls `wakeup.next()`
- **THEN** the returned Promise SHALL resolve immediately (without blocking on `client.idle()`)
- **AND** the dirty flag SHALL be cleared

#### Scenario: IdleWakeup races dirty-check against listener atomically

- **GIVEN** an `IdleWakeup(client)` with dirty=false, where `next()` is being entered AND an EXISTS event fires in the same tick
- **WHEN** the implementation reaches the dirty re-check
- **THEN** the implementation SHALL perform the re-check inside the Promise executor (after the resolver has been installed), so that whichever branch sees dirty=true first (the re-check or the listener) resolves the Promise
- **AND** no EXISTS event SHALL be lost regardless of interleaving

#### Scenario: IdleWakeup ignores EXPUNGE and FLAGS

- **GIVEN** an `IdleWakeup(client)` whose `next()` is currently blocked
- **WHEN** the server pushes EXPUNGE or FLAGS untagged responses
- **THEN** the dirty flag SHALL NOT be set
- **AND** the in-flight `next()` Promise SHALL NOT resolve as a result of those events

### Requirement: Disposition-search consistency is the author's responsibility

The runtime SHALL NOT maintain per-UID failure memory, loop-detection counters, or any other in-runtime guard against the hazard that a disposition fails to remove a message from the author's `search` predicate. A message whose disposition fails to advance it past the search (e.g. `STORE +FLAGS \Seen` rejected when the search is `UNSEEN`, or an `onError.command` that omits a flag-mutating step) SHALL continue to match the search and SHALL be re-dispatched on every subsequent drain; under `mode: "idle"`, where dirty-flag re-drains can fire many times per minute, this can produce a tight loop of `trigger.exception` events.

Authors MUST ensure that successful disposition execution removes the message from the search predicate (typical pattern: a search like `UNKEYWORD processed` paired with a disposition `STORE +FLAGS (processed)`, or `UNSEEN` paired with a `MOVE` to another folder). Authors SHALL monitor the `trigger.exception` event stream for repeated disposition failures on the same UID as their diagnostic signal.

#### Scenario: Search-disposition mismatch produces a tight loop under IDLE

- **GIVEN** an `imapTrigger` with `mode: "idle"`, `search: "UNSEEN"`, and a handler whose `onError.command` is `[]` (no disposition on failure)
- **WHEN** the handler throws on UID 42 such that no `\Seen` flag is set
- **AND** subsequent EXISTS pushes (or stale dirty-flag triggers) cause re-drains
- **THEN** UID 42 SHALL be re-dispatched on every re-drain (because it still matches `UNSEEN`)
- **AND** each re-dispatch SHALL emit its own `trigger.exception` (or `trigger.error` from the handler throw) without runtime-side throttling
- **AND** the author SHALL be expected to detect this via event-stream monitoring and redeploy a corrected workflow
