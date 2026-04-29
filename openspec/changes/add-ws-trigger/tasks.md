## 1. Core types & manifest contract

- [x] 1.1 Add `WsTriggerManifest` zod schema to `packages/core/src/manifest.ts` (or wherever `ManifestSchema` lives) with `type: "ws"` discriminator, `request` + `response` JSON Schema fields, derived `inputSchema` / `outputSchema`.
- [x] 1.2 Extend the `ManifestSchema` discriminated union to include the new variant; export the inferred `WsTriggerManifest` type.
- [x] 1.3 Add `'ws'` to `DispatchMeta.source` union in `packages/core/src/index.ts`.
- [x] 1.4 Add a `BaseTriggerDescriptor<'ws'>` arm (or per-kind descriptor type) in the runtime descriptor types module mirroring the http/cron/imap/manual descriptor shapes.
- [x] 1.5 Update `packages/core/src/index.test.ts` (and any manifest-validation unit tests) to cover the new variant: a valid ws entry parses, an entry mixing `kind:'ws'` with cross-kind fields fails.

## 2. SDK surface

- [x] 2.1 Add `WS_TRIGGER_BRAND = Symbol.for("@workflow-engine/ws-trigger")` to the SDK brand symbols module.
- [x] 2.2 Implement `wsTrigger({request, response?, handler})` factory in `packages/sdk/src/index.ts`. Default `response` to `z.any()` when omitted. Expose readonly `request`, `response`, `inputSchema`, `outputSchema` own properties; do NOT expose `handler`.
- [x] 2.3 Implement `isWsTrigger(value): value is WsTrigger` type guard.
- [x] 2.4 Extend the SDK's `Trigger` umbrella union to include `WsTrigger`.
- [x] 2.5 Wire the new export through `packages/sdk/src/index.test.ts`: brand identity, default-response substitution, type guard rejects other kinds.
- [x] 2.6 Update `packages/sdk/src/cli/build-workflows.ts` to discover `wsTrigger` exports by `WS_TRIGGER_BRAND`, derive the manifest variant, and serialize `request` + `response` JSON Schemas.
- [x] 2.7 Add a build-workflows test fixture exercising a `wsTrigger`-only workflow + a mixed http/ws workflow.

## 3. UpgradeProvider interface

- [x] 3.1 Declare `interface UpgradeProvider { upgradeHandler(req, socket, head): void; pingInterval?: number }` in `packages/runtime/src/triggers/source.ts`. Keep it separate from `TriggerSource`.
- [x] 3.2 Add `isUpgradeProvider(value): value is UpgradeProvider` structural guard alongside it.
- [x] 3.3 Unit test: structural guard returns true for a value with a function-typed `upgradeHandler`, false otherwise.

## 4. http-server upgrade-event wiring

- [x] 4.1 Extend `createServer(port, opts, middlewares, upgradeProviders?)` in `packages/runtime/src/services/server.ts`. Optional positional fourth arg; default empty.
- [x] 4.2 After `serve({fetch, port})` returns the http.Server, register one `'upgrade'` listener per provider that calls `provider.upgradeHandler(req, socket, head)`.
- [x] 4.3 Wire each provider's `pingInterval` (forwarded to the provider's own implementation; server.ts owns no per-socket state).
- [x] 4.4 Update existing `createServer` call sites to pass the new positional arg (default empty array) — verify `pnpm check` passes.
- [x] 4.5 Unit test in `services/server.test.ts`: `createServer(...)` with no upgrade providers behaves identically to the prior signature; with one provider, an upgrade request triggers the handler exactly once.

## 5. WS TriggerSource + UpgradeProvider implementation

- [x] 5.1 Add `ws` to `packages/runtime/package.json` dependencies.
- [x] 5.2 Create `packages/runtime/src/triggers/ws.ts` exporting `createWsTriggerSource(deps)` that returns a value satisfying both `TriggerSource<'ws'>` and `UpgradeProvider`.
- [x] 5.3 Construct `new WebSocketServer({ noServer: true })` once at factory call time.
- [x] 5.4 Implement an internal connection registry: `Map<scopeKey, Set<WebSocket>>` where `scopeKey = "${owner}/${repo}/${workflow}/${trigger}"`. Connections also carry their entry reference for fire dispatch.
- [x] 5.5 Implement `upgradeHandler(req, socket, head)`:
   - URL parse + segment-count + per-segment regex check.
   - Require `Upgrade: websocket` header (case-insensitive).
   - Require `Authorization: Bearer <token>`; resolve `(provider, login)` via the same code path as `apiAuthMiddleware`.
   - Check `isMember(user, owner)`.
   - Look up the entry by `(owner, repo, workflow, trigger)`; require `descriptor.kind === 'ws'`.
   - On any failure: write the literal `HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n` byte sequence on the socket, `socket.destroy()`, and emit a structured `ws.upgrade-rejected` log line with the reason. Reasons: `not-an-upgrade`, `bad-path`, `missing-authorization`, `bad-bearer`, `owner-not-member`, `trigger-not-found`, `trigger-wrong-kind`.
   - On success: `wss.handleUpgrade(req, socket, head, ws => onConnection(ws, scopeKey, entry))`.
- [x] 5.6 Implement `onConnection(ws, scopeKey, entry)`:
   - Register the socket in the registry under `scopeKey`.
   - `ws.on('message', frame => dispatchFrame(ws, entry, frame))`.
   - `ws.on('close', () => unregister(scopeKey, ws))`.
   - `ws.on('pong', () => { ws.isAlive = true })`; init `ws.isAlive = true`.
- [x] 5.7 Implement `dispatchFrame(ws, entry, frame)`:
   - If frame is binary → `ws.close(1007); return`.
   - JSON.parse; on failure → `ws.close(1007); return`.
   - Build payload `{data: parsed}`; await `entry.fire(payload, {source: 'ws'})`.
   - On `{ok:true, output}`: `ws.send(JSON.stringify(output))`.
   - On `{ok:false}` whose error class is request-validation → `ws.close(1007)`.
   - On `{ok:false}` for any other reason → `ws.close(1011)`.
- [x] 5.8 Implement `reconfigure(owner, repo, entries)`:
   - For each existing connection under `(owner, repo, *, *)` whose `(workflow, trigger)` is not in `entries`, `ws.close(1012, "service restart")`.
   - Replace the per-`(owner, repo)` entry map.
   - Always return `{ok: true}` (no user-config error class here; manifest-level validation already happened upstream).
- [x] 5.9 Implement heartbeat: `pingInterval: 30_000`. On each interval, walk the registry: dead sockets `ws.terminate()` + unregister; live sockets get `ws.isAlive = false` + `ws.ping()`. Clear interval on `stop()`.
- [x] 5.10 Implement `start()` (no-op) and `stop()` (close every socket with `1001`, clear registry, clear heartbeat interval).
- [x] 5.11 Implement `getDescriptors(): WsTriggerDescriptor[]` (or equivalent introspection used by `/trigger/*` UI; mirror what the existing TriggerSources expose).

## 6. WS unit tests (next to implementation)

- [x] 6.1 `packages/runtime/src/triggers/ws.test.ts` — registry add/remove on connection lifecycle.
- [x] 6.2 `reconfigure` closes connections whose trigger was removed (1012); keeps surviving ones; doesn't touch sibling `(owner, repo)`.
- [x] 6.3 `stop()` closes every connection (1001) across all scopes; clears heartbeat.
- [x] 6.4 Heartbeat: a socket whose pong stops arriving is terminated within two interval ticks; a live socket is not.
- [x] 6.5 `upgradeHandler` failure matrix: every "fail closed" reason produces the byte-identical 404 response and the correct log reason.
- [x] 6.6 `dispatchFrame`: binary frame → 1007; bad JSON → 1007; schema-violating JSON → 1007 (via `entry.fire` failure surface); handler throw → 1011; output-validation failure → 1011; happy path → reply frame matches `JSON.stringify(output)`.
- [x] 6.7 FIFO ordering: three handlers with staggered resolution times still produce replies in arrival order on a single connection.

## 7. main.ts wiring

- [x] 7.1 Import `createWsTriggerSource` and append to the `backends` array in `packages/runtime/src/main.ts`.
- [x] 7.2 After backends are constructed, compute `upgradeProviders = backends.filter(isUpgradeProvider)`.
- [x] 7.3 Pass `upgradeProviders` as the new fourth arg to `createServer`.
- [x] 7.4 Verify the existing startup-order invariant: backends `start()` before `serve()` binds the http server; the new upgrade-event listeners are registered AFTER bind (inside `createServer.start()`), which respects the invariant.
- [x] 7.5 Smoke-check: `pnpm dev --random-port --kill` boots; `Dev ready on http://localhost:<port>` line still appears unchanged.

## 8. Trigger UI

- [x] 8.1 Register a `ws` kind in the shared trigger-UI kind registry (mirrors how `manual` was registered).
- [x] 8.2 Render wsTrigger cards on `/trigger/<owner>/<repo>/<workflow>` with a jedison form derived from the trigger's `request` schema. Card SHALL include a `kind-trigger` span carrying the kind label `ws`.
- [x] 8.3 Wire the form's submit through the kind-agnostic manual-fire endpoint; payload reshapes to `{data: <submitted>}` and dispatches via the existing manual path with `meta.dispatch.source = 'manual'`.
- [x] 8.4 Trigger-UI unit/integration tests: WS card renders, submit produces a `manual` invocation with the correctly shaped payload.

## 9. E2E framework + tests

- [x] 9.1 Add `ws` to `packages/tests/package.json` dependencies (test-side WS client).
- [x] 9.2 Implement `.ws(triggerName, opts?, callback)` chain step in `packages/tests/src/`. Open a real WS connection; mint Bearer token via the same code path as `.fetch`; pass `sock` to the callback; auto-close on callback completion.
- [x] 9.3 Freeze the `Sock` surface in `packages/tests/src/types.ts`: `send`, `sendRaw`, `closed`, `close`. Implement FIFO reply correlation in `send` (resolves with the next inbound frame).
- [x] 9.4 Update `packages/tests/README.md` chain-method table to include `.ws`.
- [x] 9.5 Create `packages/tests/test/<n>-ws-trigger.test.ts` with two tests parallel to `15-http-trigger-protocol.test.ts`: happy path (echo handler, assert reply content) and schema-mismatch close (sendRaw bad JSON, assert `closed.code === 1007`).
- [x] 9.6 Update the e2e-test-framework spec's "19 end-to-end tests" requirement count if applicable (it bumps to 20).

## 10. Demo workflow

- [x] 10.1 Add a `wsTrigger` to `workflows/src/demo.ts`. The handler dispatches `runDemo` (preserving the every-trigger-exercises-the-orchestrator invariant) and returns its result. Declare `request` and `response` zod schemas.
- [x] 10.2 Verify `pnpm dev` auto-uploads the new demo without errors.

## 11. Documentation & SECURITY.md

- [x] 11.1 Add a SECURITY.md note under §3: `/ws/*` is authenticated (Bearer); only `/webhooks/*` is public. Note the uniform 404 fail-closed rule for `/ws/*` upgrade failures (no existence/auth distinction on the wire).
- [x] 11.2 Add a CLAUDE.md "Upgrade notes" entry for the ws-trigger landing: SDK rebuild required only for tenants who add `wsTrigger`; manifest is additive.
- [x] 11.3 Add an `openspec/project.md` paragraph mentioning `ws` as a fifth trigger kind under "Architecture Principles → Pluggable trigger backends".

## 12. Validation

- [x] 12.1 `pnpm validate` passes (lint, type-check, unit + integration tests).
- [x] 12.2 `pnpm test:wpt` not affected (sandbox-stdlib unchanged); confirm by running.
- [x] 12.3 `pnpm test:e2e` passes including the new ws-trigger test file.
- [x] 12.4 `pnpm dev --random-port --kill` boots; manual probe with `wscat` (or equivalent) against `/ws/local/demo/demo/<wsTrigger>`: connect with a valid local Bearer → reply on a valid frame; bad JSON → 1007; missing auth → 404.
