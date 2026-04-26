## MODIFIED Requirements

### Requirement: Error taxonomy

The imap source SHALL emit at most one `trigger.exception` event per `runPoll()` invocation when the cycle encounters one or more author-fixable failures. The event's `name` field SHALL be `"imap.poll-failed"`. The payload SHALL carry:

| field | type | meaning |
|---|---|---|
| `stage` | `"connect" \| "mailboxOpen" \| "search" \| "fetch" \| "disposition"` | The stage at which the cycle failed (or, when the cycle completed but had per-UID fetch failures, `"fetch"`). When multiple stages fail in the same cycle, the FIRST fatal stage SHALL be reported. |
| `failedUids` | `number[]` | UIDs whose fetch (or, in the rare disposition case, disposition) failed during this cycle. Empty `[]` for fatal stages reached before any UIDs were attempted (`connect`, `mailboxOpen`, `search`). For the `disposition` stage, contains the single in-flight UID. For the `fetch` stage, contains all UIDs whose fetch failed across the cycle. |
| `error` | `{ message: string }` | The error's message text. SHALL NOT carry a `stack` field. For `connect` failures, the message SHALL include the connect-failure classification (auth / TLS / generic) embedded in the text rather than carried as a separate top-level field. |

The imap source SHALL emit `trigger.exception` events exclusively by calling `entry.exception(params)` on the `TriggerEntry` it received via `reconfigure(owner, repo, entries)`. The source SHALL NOT import or hold a reference to the `EventBus`, the executor, or any free-floating stamping primitive — the `entry.exception` callable is the source's only outbound channel for failures, mirroring the `entry.fire(input)` callable used for handler dispatch.

A poll cycle that completes successfully (connect, mailboxOpen, search, all fetches, all dispositions all succeed) SHALL NOT call `entry.exception`.

A poll cycle whose pre-loop stages (`connect`, `mailboxOpen`, `search`) fail SHALL call `entry.exception` with the corresponding `stage` in `details` and `failedUids: []`. The cycle aborts immediately; no UIDs are attempted.

A poll cycle that reaches the per-UID loop and accumulates one or more `fetch` failures while otherwise completing SHALL call `entry.exception` with `details.stage: "fetch"` and `details.failedUids` populated, even when the cycle's overall outcome is "successful" (no fatal stage). This is the β.2 emission rule.

A poll cycle that reaches the per-UID loop and fails on `disposition` SHALL call `entry.exception` with `details.stage: "disposition"` and `details.failedUids: [<uid>]` containing the UID whose disposition failed. The cycle aborts; subsequent UIDs in the batch are not dispatched (existing batch-stop semantics under disposition failure).

The imap source SHALL NOT emit a separate Pino log entry for any of the per-stage failures captured by the per-cycle aggregator. Pino logging for those failures (the previous `imap.connect-failed` / `imap.search-failed` / `imap.fetch-failed` / `imap.disposition-failed` lines) is REMOVED.

The `imap.fire-threw` failure mode (the registry-built `entry.fire` closure itself throws — an engine bug, not an author misconfiguration) is OUTSIDE this requirement. Such failures SHALL continue to log via Pino at `error` level and SHALL NOT emit a `trigger.exception`. Handler-throw events (the handler called inside `entry.fire` throws) continue to flow through the standard `trigger.error` path emitted by the in-sandbox trigger plugin.

Repeated cycle failures on `connect` / `mailboxOpen` / `search` SHALL be subject to exponential backoff up to a cap of 15 minutes (existing behaviour). The next poll cadence SHALL reset to 60 s after one fully successful poll.

#### Scenario: Connect-refused emits one trigger.exception per cycle

- **GIVEN** an `imapTrigger` whose configured server refuses TCP connections
- **WHEN** a poll cycle runs
- **THEN** `entry.exception` SHALL be called exactly once, producing one `trigger.exception` event on the bus with `name: "imap.poll-failed"`, `stage: "connect"`, `failedUids: []`, `error: { message: <connect-error text> }`
- **AND** no `trigger.request`, `trigger.response`, or `trigger.error` event SHALL be emitted for the cycle
- **AND** no Pino log entry SHALL be emitted for the connect failure
- **AND** the source SHALL apply exponential backoff to the next poll

#### Scenario: Search rejected emits one trigger.exception with stage=search

- **GIVEN** an `imapTrigger` whose configured `search` string is rejected by the server with `BAD UNKNOWN_KEYWORD`
- **WHEN** a poll cycle reaches the SEARCH stage
- **THEN** `entry.exception` SHALL be called exactly once, producing one `trigger.exception` event on the bus with `stage: "search"`, `failedUids: []`, `error: { message: <imap NO/BAD response text> }`
- **AND** the cycle SHALL abort before any UIDs are attempted

#### Scenario: Per-UID fetch failures aggregate into a single cycle event

- **GIVEN** a poll cycle that connects, opens the folder, runs SEARCH returning UIDs `[10, 20, 30, 40]`, then fails to fetch UIDs `20` and `30` while UIDs `10` and `40` succeed and dispatch normally
- **WHEN** the cycle drains
- **THEN** `entry.exception` SHALL be called exactly once, producing one `trigger.exception` event on the bus with `stage: "fetch"`, `failedUids: [20, 30]`, `error: { message: <one of the fetch errors> }`
- **AND** UIDs `10` and `40` SHALL produce normal `trigger.request` / `trigger.response` event pairs as separate invocations

#### Scenario: Successful cycle emits no trigger.exception

- **GIVEN** a poll cycle that connects, opens the folder, runs SEARCH returning `[]`, and exits cleanly
- **WHEN** the cycle drains
- **THEN** `entry.exception` SHALL NOT be called
- **AND** no Pino log entry SHALL be emitted

#### Scenario: Disposition failure emits trigger.exception and stops the batch

- **GIVEN** a batch of 5 matching messages where the handler for message #2 (UID `22`) returns `{ command: ["UID MOVE 22 NonexistentFolder"] }` and the server responds `NO TRYCREATE`
- **WHEN** the source applies the disposition
- **THEN** `entry.exception` SHALL be called exactly once, producing one `trigger.exception` event on the bus with `stage: "disposition"`, `failedUids: [22]`, `error: { message: <NO TRYCREATE text> }`
- **AND** UIDs `33`, `44`, `55` SHALL NOT be dispatched in the current poll
- **AND** the next 60 s timer SHALL be armed normally (no exponential backoff for disposition failures)

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
