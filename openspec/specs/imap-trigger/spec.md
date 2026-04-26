# imap-trigger Specification

## Purpose
TBD - created by archiving change add-imap-trigger. Update Purpose after archive.
## Requirements
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

The returned value SHALL expose `host`, `port`, `tls`, `insecureSkipVerify`, `user`, `password`, `folder`, `search`, `onError`, `inputSchema`, `outputSchema` as readonly own properties. `inputSchema` SHALL be the Zod schema describing `ImapMessage`. `outputSchema` SHALL be `z.object({ command: z.array(z.string()).optional() })`. The captured `handler` SHALL NOT be exposed as a public property.

#### Scenario: imapTrigger returns branded callable

- **GIVEN** `const t = imapTrigger({ host: "imap.example", port: 993, tls: "required", user: "u", password: "p", folder: "INBOX", search: "UNSEEN", handler: async () => ({}) })`
- **WHEN** the value is inspected
- **THEN** `t` SHALL be a function (callable)
- **AND** `t[IMAP_TRIGGER_BRAND]` SHALL be `true`
- **AND** `t.host`, `t.port`, `t.tls`, `t.user`, `t.password`, `t.folder`, `t.search`, `t.inputSchema`, `t.outputSchema` SHALL be exposed as readonly properties
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

#### Scenario: imapTrigger callable invokes the handler

- **GIVEN** `const t = imapTrigger({ ..., handler: async (msg) => ({ command: [\`UID STORE \${msg.uid} +FLAGS (\\\\Seen)\`] }) })`
- **WHEN** `await t({ uid: 42, ...rest })` is called
- **THEN** the handler SHALL be invoked with the argument
- **AND** the return value SHALL be `{ command: ["UID STORE 42 +FLAGS (\\Seen)"] }`

### Requirement: ImapMessage is the handler input shape

The handler SHALL receive a single argument `msg: ImapMessage` with the following shape:

```
{
  uid: number,
  messageId?: string,
  inReplyTo?: string,
  references: string[],
  from: { name?: string, address: string },
  to: Array<{ name?: string, address: string }>,
  cc: Array<{ name?: string, address: string }>,
  bcc: Array<{ name?: string, address: string }>,
  replyTo?: Array<{ name?: string, address: string }>,
  subject: string,
  date: string,                                 // ISO 8601
  text?: string,
  html?: string,
  headers: Record<string, string[]>,            // duplicate header keys preserved as arrays
  attachments: Array<{
    filename?: string,
    contentType: string,
    size: number,
    contentId?: string,
    contentDisposition?: "inline" | "attachment",
    content: string                             // base64
  }>
}
```

The source SHALL FETCH the message via `imapflow`, parse it via `postal-mime` with `attachmentEncoding: "base64"`, and pass the resulting `ImapMessage` to the handler. Attachment bytes SHALL be base64-inline in the payload; the bridge between main and sandbox is JSON-only, so streaming or out-of-band handles are not permitted.

#### Scenario: Handler receives parsed envelope

- **GIVEN** a matching message with subject "Hello", from "Alice <alice@example.com>"
- **WHEN** the handler is invoked
- **THEN** `msg.subject` SHALL equal `"Hello"`
- **AND** `msg.from` SHALL equal `{ name: "Alice", address: "alice@example.com" }`

#### Scenario: Handler receives attachment as base64 string

- **GIVEN** a message with a single PDF attachment `report.pdf`
- **WHEN** the handler is invoked
- **THEN** `msg.attachments` SHALL be a one-element array
- **AND** `msg.attachments[0].filename` SHALL equal `"report.pdf"`
- **AND** `msg.attachments[0].contentType` SHALL equal `"application/pdf"`
- **AND** `typeof msg.attachments[0].content` SHALL equal `"string"` (base64)

#### Scenario: Duplicate header keys preserved

- **GIVEN** a message with two `Received:` headers
- **WHEN** the handler is invoked
- **THEN** `msg.headers["received"]` SHALL be a two-element array with both values preserved in order

### Requirement: ImapTriggerResult is a disposition envelope

The handler's return value and the trigger's `onError` SHALL have the type `ImapTriggerResult`:

```
{ command?: string[] }
```

Each entry in `command` SHALL be a raw IMAP command suffix that the source passes verbatim to `imapflow`'s `connection.exec()` against the current session. The source SHALL NOT parse, validate, or otherwise interpret these strings. Authors SHALL write full UID-scoped commands where applicable (e.g. `` `UID STORE ${msg.uid} +FLAGS (\\Seen)` ``); the source does NOT bind the UID for them.

Omitting `command` or returning `{}` SHALL result in no IMAP operations being executed on the message.

#### Scenario: Mark message as read

- **GIVEN** a handler `async (msg) => ({ command: [\`UID STORE \${msg.uid} +FLAGS (\\\\Seen)\`] })`
- **WHEN** invoked with `msg.uid === 42`
- **THEN** the return value SHALL equal `{ command: ["UID STORE 42 +FLAGS (\\Seen)"] }`
- **AND** the source SHALL execute `UID STORE 42 +FLAGS (\Seen)` against the server

#### Scenario: Handler returns empty envelope

- **GIVEN** a handler `async () => ({})`
- **WHEN** invoked
- **THEN** no IMAP commands SHALL be executed on the message

#### Scenario: Handler returns empty command array

- **GIVEN** a handler `async () => ({ command: [] })`
- **WHEN** invoked
- **THEN** no IMAP commands SHALL be executed on the message

#### Scenario: Delete disposition composes multiple commands

- **GIVEN** a handler returning `{ command: [\`UID STORE \${msg.uid} +FLAGS (\\\\Deleted)\`, \`UID EXPUNGE \${msg.uid}\`] }`
- **WHEN** invoked with `msg.uid === 7`
- **THEN** the source SHALL execute `UID STORE 7 +FLAGS (\Deleted)` first
- **AND** SHALL execute `UID EXPUNGE 7` second

### Requirement: Disposition strings are passed verbatim

The imap source SHALL pass each string in `ImapTriggerResult.command` verbatim to `imapflow`'s `connection.exec()` method. The source SHALL NOT validate the verb, the argument shape, or the UID scoping. Documented supported verbs are `UID STORE`, `UID COPY`, `UID MOVE`, `UID EXPUNGE`, and `EXPUNGE`; any other verb is the author's responsibility and the resulting server behaviour is unspecified.

The imap source SHALL NOT run `resolveSecretSentinels` on handler output. Sentinel substitution applies only to manifest-sourced strings (see `workflow-secrets` spec); handler outputs are runtime values and are scrubbed for registered plaintexts by the sandbox-side plaintext scrubber on the outbound `WorkerToMain` message path.

#### Scenario: Disposition string reaches server unchanged

- **GIVEN** a handler returning `{ command: ["UID STORE 1 +FLAGS (my-label)"] }`
- **WHEN** the source applies the disposition
- **THEN** the on-wire IMAP command SHALL be `UID STORE 1 +FLAGS (my-label)` (modulo protocol tag / framing)

#### Scenario: Handler output bypasses sentinel resolution

- **GIVEN** a handler that returns a string containing the byte sequence `"\x00secret:FOO\x00"` (e.g. by concatenating `workflow.env.SECRET` into a command)
- **WHEN** the source receives the output
- **THEN** the source SHALL NOT run `resolveSecretSentinels` on the output
- **AND** the plaintext scrubber on the `WorkerToMain` path SHALL redact any registered plaintext literals before the event reaches the event bus

### Requirement: onError disposition on handler failure

When the handler throws or the returned Promise rejects, the imap source SHALL:
1. Emit a `trigger.error` event via the standard executor path (kind `handler-failed`).
2. Apply the `onError` disposition from the trigger config — executing each string in `onError.command` verbatim via `connection.exec()`, in order.
3. Continue to the next message in the batch (handler failure alone does NOT stop the batch).

If the `onError` disposition itself fails (server `NO` / `BAD` response on a command inside `onError.command`), the source SHALL emit an additional `trigger.error` event with `reason: "disposition-failed"`, stop the batch, and let the next poll retry from scratch.

#### Scenario: Handler throws applies onError

- **GIVEN** an imapTrigger with `onError: { command: [\`UID STORE \${msg.uid} +FLAGS (\\\\Seen error)\`] }` and a handler that throws
- **WHEN** the source invokes the handler on a matching message
- **THEN** a `trigger.error` event SHALL be emitted (executor-standard handler-failed shape)
- **AND** the source SHALL execute `UID STORE <uid> +FLAGS (\Seen error)` against the server
- **AND** the source SHALL proceed to the next message in the batch

#### Scenario: Handler throws with empty onError

- **GIVEN** an imapTrigger with `onError: {}` (or omitted) and a handler that throws
- **WHEN** the source invokes the handler on a matching message
- **THEN** a `trigger.error` event SHALL be emitted
- **AND** no IMAP commands SHALL be executed on the message
- **AND** the source SHALL proceed to the next message in the batch

### Requirement: ImapTriggerSource polling lifecycle

The runtime SHALL provide `packages/runtime/src/triggers/imap.ts` exporting an `ImapTriggerSource` implementing `TriggerSource<"imap", ImapTriggerDescriptor>`. The source SHALL:

1. On `start()`: allocate per-source state (no external connections; no timers armed).
2. On `reconfigure(owner, repo, entries)`: replace the `(owner, repo)` entry map for the `"imap"` kind in full. Cancel any in-flight poll-scheduling timer for removed entries. Arm a 60 s timer for each current entry.
3. On timer tick for an entry: open a fresh TCP/TLS connection (observing `tls` and `insecureSkipVerify`); authenticate via `LOGIN user password`; `SELECT` the configured `folder`; `UID SEARCH <search>`; for each matching UID serially: `UID FETCH body[]`, parse via `postal-mime`, invoke `entry.fire(parsedMsg)` via the executor, apply the returned `ImapTriggerResult.command` (or on handler error, the trigger's `onError.command`); `LOGOUT`; close. Re-arm the 60 s timer for the next tick **after** the batch drains.
4. In-flight poll re-entry SHALL NOT occur: the re-arm happens only after the current batch completes, so a given trigger never has two poll loops running simultaneously.
5. On `stop()`: cancel all armed timers; close any open connection.

The source SHALL use the `imapflow` library for the IMAP client and `postal-mime` for MIME parsing.

#### Scenario: Reconfigure replaces entries in full

- **GIVEN** an `ImapTriggerSource` with a previously-registered entry for `(owner=acme, repo=billing, trigger=inbound)`
- **WHEN** `reconfigure("acme", "billing", [])` is called with an empty entry list
- **THEN** the source SHALL cancel the armed timer for the `inbound` trigger
- **AND** no further polls SHALL fire for that entry
- **AND** other `(owner, repo)` entries SHALL be unaffected

#### Scenario: Next poll does not start until current batch drains

- **GIVEN** a batch of 10 matching messages and a handler that takes 1 s per message
- **WHEN** the poll tick fires
- **THEN** all 10 messages SHALL be dispatched serially
- **AND** the next 60 s timer SHALL be armed only after the last message's disposition has been applied (i.e. ~ `now + 10 s + 60 s` from the original tick)

### Requirement: SEARCH composition — raw passthrough

The imap source SHALL pass the descriptor's `search` string verbatim to the IMAP `UID SEARCH` command. The source SHALL NOT prepend, append, or otherwise compose the author's string with engine-added criteria. Dedup is the author's responsibility — e.g. by including `UNKEYWORD <their-keyword>` or `SINCE <date>` in the `search` string and returning a disposition that sets a matching keyword or advances the state the SEARCH predicates against.

The source SHALL apply IMAP literal encoding (`{N}\r\n<bytes>`) to any embedded quoted string arguments so that author-supplied strings containing quote or CRLF bytes cannot break protocol framing.

#### Scenario: Search string reaches server unchanged

- **GIVEN** `search: "UNSEEN FROM \"boss@example.com\""`
- **WHEN** the source issues the `UID SEARCH`
- **THEN** the on-wire criteria SHALL be `UNSEEN FROM "boss@example.com"` (modulo literal-framing for the quoted argument)

#### Scenario: Author controls dedup via SEARCH

- **GIVEN** a handler that returns `{ command: [\`UID STORE \${msg.uid} +FLAGS (processed)\`] }` and `search: "UNKEYWORD processed"`
- **WHEN** a message is processed and flagged `processed`
- **THEN** subsequent polls' SEARCH SHALL NOT match that message

### Requirement: Credentials and other string fields via sentinel resolution

The `ImapTriggerDescriptor`'s string-typed fields (`host`, `user`, `password`, `folder`, `search`) SHALL accept `\x00secret:NAME\x00` sentinel substrings. The `WorkflowRegistry` SHALL resolve all sentinels to plaintext via `resolveSecretSentinels` before calling `ImapTriggerSource.reconfigure`, per the existing `workflow-secrets` / `workflow-registry` spec. The imap source SHALL NOT parse sentinel syntax — it receives already-resolved plaintext strings in every descriptor it holds.

Non-string fields (`port: number`, `tls: enum`, `insecureSkipVerify: boolean`) do NOT participate in sentinel resolution and MUST be literal or plain-env-derived values at build time.

#### Scenario: Sealed password reaches source as plaintext

- **GIVEN** a workflow declaring `env: { IMAP_PASSWORD: env({ secret: true }) }` and an `imapTrigger` using `password: wf.env.IMAP_PASSWORD`
- **WHEN** the registry installs the workflow
- **THEN** the descriptor passed to `ImapTriggerSource.reconfigure` SHALL contain `password: <plaintext>` (the decrypted value)
- **AND** the descriptor SHALL NOT contain any `\x00secret:` byte sequence

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

### Requirement: trigger.response.output carries the disposition

The `trigger.response.output` field emitted by the executor on successful handler return SHALL carry the full `ImapTriggerResult` envelope (`{ command?: string[] }`). The dashboard SHALL render the command list so operators can see what was executed against the server. The plaintext scrubber in the sandbox secrets plugin SHALL apply to `trigger.response` as usual — any registered plaintext literal (from `workflow.env.*` or `secret(...)`) that appears inside a command string SHALL be redacted before the event leaves the sandbox.

#### Scenario: Successful invocation output in event stream

- **GIVEN** a handler returning `{ command: ["UID STORE 42 +FLAGS (\\Seen)"] }`
- **WHEN** the invocation completes
- **THEN** the archived `trigger.response` event SHALL have `output` equal to `{ command: ["UID STORE 42 +FLAGS (\\Seen)"] }`

#### Scenario: Registered plaintext inside command is scrubbed

- **GIVEN** a handler building a command via `` `UID STORE ${msg.uid} +FLAGS (${workflow.env.SECRET_TAG})` `` where `SECRET_TAG = "abc"`
- **WHEN** the invocation completes and the event is archived
- **THEN** the archived `trigger.response.output.command[0]` SHALL NOT contain the string `"abc"`
- **AND** it SHALL contain `"[secret]"` in that position

### Requirement: Dev loop and test harness via hoodiecrow-imap

The repository SHALL use `hoodiecrow-imap` (MIT-licensed, Andris Reinman) as the in-process IMAP server for BOTH unit/integration tests and the operator-driven `pnpm imap` foreground script.

The repository SHALL ship `scripts/imap.ts` which boots `hoodiecrow-imap` on `localhost:3993` with IMAPS enabled via self-signed certificate, dev credentials `dev@localhost` / `devpass`, and the plugins `STARTTLS`, `UIDPLUS`, `MOVE`, `IDLE`, `LITERALPLUS` enabled. The script SHALL block on SIGINT / SIGTERM and cleanly shut down the server.

The repository SHALL expose this as `pnpm imap`. The repository MAY additionally expose an `imap:send` (or `pnpm imap send`) helper that performs `APPEND INBOX` of a synthetic test message against a running `pnpm imap` server for operator probing.

`scripts/dev.ts`'s `DEV_SECRET_DEFAULTS` table SHALL include `IMAP_USER: "dev@localhost"` and `IMAP_PASSWORD: "devpass"` so the CLI seals these values into the dev-tenant manifest automatically.

The canonical probe workflow `workflows/src/demo.ts` SHALL declare `IMAP_USER` / `IMAP_PASSWORD` as sealed env bindings and SHALL include one `imapTrigger` named `inbound` pointed at `localhost:3993` with `insecureSkipVerify: true` and a handler + `onError` that exercise the happy-path disposition.

#### Scenario: pnpm imap boots hoodiecrow on port 3993

- **WHEN** the operator runs `pnpm imap`
- **THEN** a hoodiecrow-imap server SHALL be listening on `localhost:3993` with IMAPS
- **AND** the account `dev@localhost` with password `devpass` SHALL authenticate successfully
- **AND** the advertised `CAPABILITY` SHALL include `UIDPLUS`, `MOVE`, `IDLE`, `STARTTLS`, `LITERAL+`

#### Scenario: Unit tests use the same bootstrap on a random port

- **WHEN** the imap trigger integration tests run
- **THEN** each test suite SHALL spawn a hoodiecrow-imap instance on a free port
- **AND** SHALL tear it down at suite end

#### Scenario: Demo workflow boots against local hoodiecrow

- **GIVEN** `pnpm imap` is running and `pnpm dev` uploaded `demo.ts`
- **WHEN** a new message is appended to the `INBOX` of `dev@localhost` (via `pnpm imap:send` or equivalent)
- **THEN** within one poll interval the `inbound` trigger SHALL fire
- **AND** a `trigger.request` / `trigger.response` pair SHALL land in `.persistence/`

