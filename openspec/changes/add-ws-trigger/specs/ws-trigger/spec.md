## ADDED Requirements

### Requirement: wsTrigger factory creates branded WsTrigger

The SDK SHALL export a `wsTrigger(config)` factory that returns a `WsTrigger` value branded with `Symbol.for("@workflow-engine/ws-trigger")`.

The config SHALL require:
- `request`: `ZodType` — schema for inbound message data; the parsed JSON of every inbound frame is validated against this schema before the handler runs.
- `handler`: `(payload: { data: <inferred from request> }) => Promise<<inferred from response | unknown>>` — async handler invoked once per inbound message.

The config SHALL accept optional:
- `response`: `ZodType` — schema for the handler's return value. If omitted (defaults to `z.any()`), the handler return is sent back to the originating client unchanged. If provided, the return value is validated host-side; validation failure closes the connection with code `1011`.

The returned value SHALL expose `request`, `response` (or its `z.any()` default), `inputSchema`, `outputSchema` as readonly own properties. `inputSchema` SHALL be the JSON Schema derived from `request`. `outputSchema` SHALL be the JSON Schema derived from `response`. The captured `handler` SHALL NOT be exposed as a public own property.

#### Scenario: wsTrigger returns branded value

- **GIVEN** `const t = wsTrigger({ request: z.object({greet: z.string()}), handler: async ({data}) => ({echo: data.greet}) })`
- **WHEN** the value is inspected
- **THEN** `t[WS_TRIGGER_BRAND]` SHALL be `true`
- **AND** `t.request`, `t.response`, `t.inputSchema`, `t.outputSchema` SHALL be exposed as readonly properties
- **AND** `t.handler` SHALL NOT be defined as an own property

#### Scenario: wsTrigger response defaults to z.any()

- **GIVEN** `const t = wsTrigger({ request: z.object({}), handler: async () => 'ok' })`
- **WHEN** the value is inspected
- **THEN** `t.response` SHALL be a `ZodAny` instance
- **AND** `t.outputSchema` SHALL be the JSON Schema for `z.any()` (i.e. `{}`)

### Requirement: WS TriggerSource and UpgradeProvider implementation

The runtime SHALL implement at `packages/runtime/src/triggers/ws.ts` a value that satisfies BOTH the `TriggerSource<"ws">` interface AND the new `UpgradeProvider` interface (defined in the `triggers` capability).

The source SHALL maintain an internal connection registry keyed by the tuple `(owner, repo, workflowName, triggerName)`. On every accepted upgrade the source SHALL register the resulting `WebSocket` under the matching key.

`reconfigure(owner, repo, entries)` SHALL:
- Compare the incoming entries to the current per-`(owner, repo)` entry set.
- For every existing connection whose `(workflowName, triggerName)` no longer appears in `entries`, the source SHALL call `ws.close(1012, "service restart")`.
- Update the entry set so subsequent upgrades for that `(owner, repo)` use the new entries.
- Sibling `(owner, repo)` pairs SHALL NOT be affected.

`stop()` SHALL call `ws.close(1001, "going away")` on every open connection across all scopes, then resolve.

`start()` SHALL be a no-op (the upgrade event is wired by `services/server.ts` after `serve()` binds; the source supplies its `upgradeHandler` as part of the `UpgradeProvider` interface).

The source SHALL NOT call `executor.invoke` directly. Inbound frame dispatch goes through `entry.fire(input)` constructed by the registry's `buildFire` helper.

#### Scenario: reconfigure closes connections whose trigger was removed

- **GIVEN** open WS connections for `(acme, foo)` triggers `chat` and `notify`
- **WHEN** `reconfigure("acme", "foo", [chatEntry])` is called (no `notify` entry)
- **THEN** every `notify` connection SHALL receive `close(1012)`
- **AND** every `chat` connection SHALL remain open
- **AND** connections under `(acme, bar)` SHALL NOT be affected

#### Scenario: stop closes all connections with 1001

- **GIVEN** N open connections across multiple `(owner, repo)` pairs
- **WHEN** `stop()` is called
- **THEN** every connection SHALL receive `close(1001, "going away")`
- **AND** the registry SHALL be empty when `stop()` resolves

### Requirement: Upgrade-time URL routing and authentication

The source's `upgradeHandler(req, socket, head)` SHALL parse the request URL and dispatch as follows:

1. **Path match.** The URL SHALL match `/ws/<owner>/<repo>/<workflow>/<trigger>` exactly — four segments after the `/ws/` prefix, no more, no less. `owner` SHALL match `OWNER_NAME_RE`, `repo` SHALL match `REPO_NAME_RE`, both `workflow` and `trigger` SHALL match `TRIGGER_NAME_RE`. Mismatch on any segment SHALL fail closed.
2. **Upgrade header check.** The request SHALL carry `Upgrade: websocket` (case-insensitive). Missing or non-websocket SHALL fail closed.
3. **Authentication.** The request SHALL carry `Authorization: Bearer <token>`. The token SHALL be validated identically to `apiAuthMiddleware` (same `(provider, login)` resolution, same `AUTH_ALLOW` predicate). Missing, malformed, or unrecognized token SHALL fail closed.
4. **Owner membership.** The resolved user SHALL satisfy `isMember(user, owner)`. Non-member SHALL fail closed.
5. **Trigger lookup.** The source SHALL find an entry in its registry matching the path's `(owner, repo, workflow, trigger)`. Missing entry SHALL fail closed.
6. **Upgrade.** On all checks passing, the source SHALL call `wss.handleUpgrade(req, socket, head, ws => onConnection(ws, entry))` exactly once.

Every "fail closed" path SHALL write the literal byte sequence of an `HTTP/1.1 404 Not Found` response on the socket (with `Content-Length: 0` and `Connection: close`), then call `socket.destroy()`. The wire response SHALL be byte-identical across all failure causes.

The source SHALL log a structured `ws.upgrade-rejected` line with the failure reason for operator triage. The reason SHALL NOT appear in the response.

#### Scenario: Missing Authorization → 404

- **GIVEN** an upgrade request to `/ws/local/demo/chat/messages` with no `Authorization` header
- **WHEN** `upgradeHandler` runs
- **THEN** the socket SHALL receive an `HTTP/1.1 404 Not Found` response
- **AND** the socket SHALL be destroyed
- **AND** an `ws.upgrade-rejected` log line SHALL be emitted with `reason: "missing-authorization"`

#### Scenario: Cross-owner Bearer → 404

- **GIVEN** a valid Bearer token for user `bob` and an upgrade to `/ws/acme/private/x/y` where `isMember(bob, acme)` is false
- **WHEN** `upgradeHandler` runs
- **THEN** the response on the wire SHALL be byte-identical to the missing-auth case
- **AND** the log line SHALL carry `reason: "owner-not-member"`

#### Scenario: Unknown trigger → 404

- **GIVEN** an authenticated upgrade to `/ws/local/demo/chat/missing` where `missing` is not registered
- **WHEN** `upgradeHandler` runs
- **THEN** the response SHALL be the same `HTTP/1.1 404 Not Found`
- **AND** the log line SHALL carry `reason: "trigger-not-found"`

#### Scenario: Non-upgrade GET → 404

- **GIVEN** a plain `GET /ws/local/demo/chat/messages` with no `Upgrade` header
- **WHEN** `upgradeHandler` runs
- **THEN** the response SHALL be the same `HTTP/1.1 404 Not Found`
- **AND** the log line SHALL carry `reason: "not-an-upgrade"`

### Requirement: Per-message dispatch pipeline

For every accepted connection the source SHALL install message, close, and pong handlers. On each inbound text frame the source SHALL:

1. **Parse JSON.** Attempt `JSON.parse(frame)`. Failure SHALL close the connection with code `1007` and emit a `trigger.rejection` lifecycle event with `reason: "json-parse"`.
2. **Construct payload.** Build `{ data: <parsed> }`. The payload SHALL contain only the `data` key — no headers, no URL, no method, no user identity, no connection id.
3. **Dispatch.** Call `entry.fire({data}, {source: "ws"})`. The `fire` closure validates `data` against the trigger's `request` zod schema and runs the handler in the per-workflow runQueue.
4. **Handle the result.**
   - On `{ok: true, output}`: serialize `output` as JSON and send as a single text frame to the originating connection (and only that connection).
   - On `{ok: false, error}` where the error is a validation failure of the inbound payload: close the connection with code `1007`. (`fire` already emits `trigger.rejection`.)
   - On `{ok: false, error}` for any other reason (handler throw, output validation failure): close the connection with code `1011`. (`fire` already emits `trigger.error`.)

Inbound binary frames SHALL be treated as a JSON-parse failure (close `1007`).

The source SHALL NOT enqueue a second inbound frame's dispatch until the prior frame's handler has resolved (FIFO per connection). Across multiple connections, the per-workflow runQueue serializes interleaved dispatch in arrival order.

#### Scenario: Valid frame produces reply

- **GIVEN** a wsTrigger `echo` with `request: z.object({greet: z.string()})`, `response: z.object({echo: z.string()})`, handler returns `{echo: data.greet}`
- **WHEN** the client sends `{"greet": "hi"}`
- **THEN** the source SHALL send a single text frame `{"echo": "hi"}` to the originating connection
- **AND** the connection SHALL remain open

#### Scenario: Bad JSON closes 1007

- **GIVEN** an open WS connection
- **WHEN** the client sends the literal text frame `not json`
- **THEN** the connection SHALL close with code `1007`
- **AND** a `trigger.rejection` event SHALL be emitted with `reason: "json-parse"`

#### Scenario: Schema mismatch closes 1007

- **GIVEN** a wsTrigger with `request: z.object({greet: z.string()})`
- **WHEN** the client sends `{"greet": 42}`
- **THEN** the connection SHALL close with code `1007`
- **AND** a `trigger.rejection` event SHALL be emitted with the zod issues

#### Scenario: Handler throw closes 1011

- **GIVEN** a wsTrigger whose handler throws on every input
- **WHEN** the client sends a schema-valid frame
- **THEN** the connection SHALL close with code `1011`
- **AND** a `trigger.error` event SHALL be emitted

#### Scenario: Binary frame treated as bad payload

- **GIVEN** an open WS connection
- **WHEN** the client sends a binary frame
- **THEN** the connection SHALL close with code `1007`

#### Scenario: FIFO reply order per connection

- **GIVEN** a wsTrigger whose handler returns `{seq: data.seq}` after a 10ms delay
- **WHEN** the client sends frames `{seq:1}`, `{seq:2}`, `{seq:3}` back-to-back
- **THEN** the client SHALL receive replies in the order `seq:1`, `seq:2`, `seq:3`

### Requirement: Heartbeat liveness via ping/pong

The source SHALL configure ping/pong liveness via the `UpgradeProvider`-declared `pingInterval` field, set to `30_000` ms in v1. Implementation:

- On every accepted connection, the source SHALL initialize a per-socket `isAlive: true` flag.
- On `pong` events, the flag SHALL be set to `true`.
- A single per-source interval timer (period = `pingInterval`) SHALL iterate the registry: if a socket's `isAlive` is `false`, the source SHALL call `ws.terminate()` (immediate destroy, no closing handshake) and remove it from the registry; otherwise the source SHALL set the flag to `false` and call `ws.ping()`.
- The interval SHALL be cleared on `stop()`.

`pingInterval` SHALL NOT be a manifest field, an SDK config field, or a workflow-author-visible setting in v1.

#### Scenario: Dead client terminated within two intervals

- **GIVEN** an open connection whose peer has gone silent (no pongs)
- **WHEN** two heartbeat intervals elapse
- **THEN** the source SHALL call `ws.terminate()` on the socket
- **AND** the socket SHALL be removed from the registry

#### Scenario: Live client survives heartbeat

- **GIVEN** an open connection whose peer responds to every ping
- **WHEN** any number of heartbeat intervals elapse
- **THEN** the connection SHALL remain in the registry
- **AND** `terminate()` SHALL NOT be called

### Requirement: Trigger UI manual fire

The `/trigger/*` UI SHALL render a request-schema form for every wsTrigger, identical to how it renders for HTTP / cron / manual / imap triggers (see `trigger-ui` capability). Submitting the form SHALL fire the trigger via the existing manual dispatch path with `meta.dispatch.source = 'manual'`. The handler SHALL run once; its return SHALL be displayed to the user in the existing result dialog. No live WS connection is involved.

WS-trigger manual fires SHALL NOT push the result to currently-connected WS clients in v1 (no broadcast capability; replies are only sent to the originating client of a real socket). This SHALL be revisited when the broadcast change ships.

#### Scenario: WS trigger renders form

- **GIVEN** a workflow with `wsTrigger({request: z.object({greet: z.string()}), …})`
- **WHEN** the user opens `/trigger/<owner>/<repo>/<workflow>`
- **THEN** the page SHALL render a jedison form for the `request` schema alongside the workflow's other triggers

#### Scenario: WS trigger manual fire dispatches via manual path

- **WHEN** the user submits the WS trigger's form
- **THEN** the trigger handler SHALL run once with the submitted input as `data`
- **AND** the resulting invocation SHALL carry `meta.dispatch.source = 'manual'`
- **AND** the handler's return SHALL be displayed in the result dialog

### Requirement: Demo workflow exercises wsTrigger

`workflows/src/demo.ts` SHALL include a `wsTrigger` export whose handler dispatches the existing `runDemo` orchestrator (preserving the every-trigger-exercises-the-orchestrator invariant established by the prior trigger kinds). The trigger SHALL declare both `request` and `response` schemas so the demo exercises the typed-reply path.

#### Scenario: Demo wsTrigger reachable via /ws

- **GIVEN** the demo workflow uploaded under owner `local` repo `demo`
- **WHEN** `pnpm dev` is running and a Bearer-authenticated WS client connects to `/ws/local/demo/demo/<wsTriggerName>`
- **THEN** the upgrade SHALL succeed
- **AND** sending a schema-valid frame SHALL produce a reply consistent with `runDemo`'s output shape
