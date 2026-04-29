## ADDED Requirements

### Requirement: WS chain step

The chain DSL exported from `@workflow-engine/tests` SHALL include a `.ws(triggerName, opts?, callback)` method. Calling it queues a step that, at run time, opens a real WebSocket connection against the spawned runtime, runs the user-supplied async `callback`, then auto-closes the connection if the callback didn't already close it.

`opts` (optional) SHALL accept:
- `auth?: { user: string; via?: "api-header" }` — Bearer token derived from the user's `AUTH_ALLOW` entry (default `via: "api-header"`; no other modes supported in v1).
- `owner?: string` — defaults to `"dev"`.
- `repo?: string` — defaults to `"e2e"`.
- `workflow?: string` — defaults to the most recently uploaded workflow name in scope.
- `label?: string` — optional capture label (currently unused; reserved for future cross-step state).

`callback` SHALL receive a single argument `sock` whose surface is frozen for v1:
- `sock.send(data: unknown): Promise<unknown>` — JSON-serializes `data`, sends it as a single text frame, and resolves with the parsed JSON of the next inbound frame from this connection (FIFO-correlated). Rejects if the connection closes before a reply arrives.
- `sock.sendRaw(payload: string | Buffer): void` — fire-and-forget; sends the payload as-is. Used to test malformed-input close paths.
- `sock.closed: Promise<{ code: number; reason?: string }>` — resolves when the peer closes the connection. Used to assert close codes.
- `sock.close(code?: number): void` — client-initiated close (default `1000`).

The framework SHALL set `Authorization: Bearer <token>` on the upgrade request when `auth.user` is provided, using the same token-minting logic as the `.fetch` step.

The framework SHALL automatically `sock.close(1000)` any still-open connection at the end of the callback.

#### Scenario: Happy-path send/receive

- **GIVEN** a workflow uploaded with a `wsTrigger` named `echo`
- **WHEN** a test runs `.ws('echo', { auth: { user: 'alice' } }, async sock => { const r = await sock.send({greet:'hi'}); expect(r).toEqual({echo:'hi'}) })`
- **THEN** the framework SHALL open a WS connection to `/ws/dev/e2e/<workflow>/echo` with the correct Bearer token
- **AND** SHALL deliver the reply frame to `sock.send`'s resolved value
- **AND** SHALL close the connection with code `1000` after the callback returns

#### Scenario: sendRaw + closed for malformed-input test

- **GIVEN** a wsTrigger with a strict `request` schema
- **WHEN** a test runs `.ws('strict', { auth: { user: 'alice' } }, async sock => { sock.sendRaw('not json'); const c = await sock.closed; expect(c.code).toBe(1007) })`
- **THEN** `sock.sendRaw` SHALL deliver the literal text frame `not json`
- **AND** `sock.closed` SHALL resolve with `{code: 1007}`

### Requirement: Two e2e tests for wsTrigger protocol adapter

The e2e suite at `packages/tests/test/` SHALL include a numbered test file for the wsTrigger protocol adapter, following the test-author surface defined in this capability. The file SHALL contain at minimum two tests parallel in shape to test `15-http-trigger-protocol.test.ts`:

1. **Happy path**: open a WS connection to a wsTrigger whose handler echoes its input; assert the reply frame's content.
2. **Schema mismatch closes 1007**: send a JSON payload that violates the `request` schema; assert `sock.closed.code === 1007`.

Additional close-code paths (`1011` handler-throw, `1012` reconfigure, heartbeat, FIFO ordering across concurrent frames, cross-owner 404) SHALL NOT be covered by e2e tests; they live in the unit test suite at `packages/runtime/src/triggers/ws.test.ts`. This split mirrors the existing httpTrigger coverage shape (e2e covers protocol adapter happy + schema-422; unit covers the exhaustive logic matrix).

#### Scenario: Two e2e tests exist

- **WHEN** the e2e suite is collected
- **THEN** the new test file SHALL contain at least two `test(...)` calls
- **AND** one SHALL exercise the happy-path send/receive
- **AND** one SHALL exercise the 1007 close path via `sendRaw` + `closed`
