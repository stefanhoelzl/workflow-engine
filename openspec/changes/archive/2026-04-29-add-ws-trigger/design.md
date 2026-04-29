## Context

The runtime today supports only one-shot trigger kinds. HTTP webhooks accept a request and return a response on the same call; cron fires a handler with no payload; IMAP polls a mailbox; manual is a UI/test fire. None of these support a long-lived bidirectional connection.

Adding WebSocket support introduces three concerns the codebase has never had:

1. **Long-lived state on the runtime.** Today the runtime is request/response — every concern is bounded by a single Hono request lifecycle. WS connections persist for hours; the runtime needs a connection registry.
2. **An ingress channel that bypasses Hono's fetch dispatch.** WebSocket upgrades land on `http.Server`'s `'upgrade'` event, not on Hono's request handler. The current `services/server.ts` constructs the http server inside `serve({fetch, port})` and never exposes it for upgrade handling.
3. **A new failure shape.** HTTP triggers fail loudly via 4xx/5xx response bodies. WS has close codes but no body — and any post-upgrade failure is a wire close, not a synchronous reject the client can read.

This change is deliberately scoped tight: inbound trigger only. Broadcast (action-side `wsBroadcast` to push from outside the originating handler) is a follow-up because its host-callable plugin shape, schema design, and registry-lookup contract are independently complex enough to deserve their own change.

The interview that produced this design walked the full decision tree (per-message vs per-connection model, addressing model, auth transport, payload shape, failure semantics, registry persistence, server-side pieces, e2e test scope) before scoping back to WS-trigger-only.

## Goals / Non-Goals

**Goals:**
- Per-message trigger invocation that fits the existing handler-per-trigger model (sandbox reset per run, JSON across the bridge, FIFO reply correlation via the per-workflow runQueue).
- Authenticated ingress at `/ws/<owner>/<repo>/<workflow>/<trigger>` with the same fail-closed posture as the rest of the runtime (uniform `404` for non-upgrade / unauthorized / unknown).
- A clean separation between the trigger contract (`TriggerSource`) and the new upgrade-handling contract (`UpgradeProvider`), so future protocols (WebTransport, raw TCP) can plug into the http server without bloating the trigger interface.
- Heartbeat-driven liveness so silently-dead clients don't accumulate in the registry.
- Two e2e tests parallel to httpTrigger's coverage; exhaustive close-code logic in unit tests.
- `/trigger/*` UI auto-renders a request-schema form like every other kind; manual fire dispatches via the existing manual path.

**Non-Goals:**
- Broadcast / `wsBroadcast` SDK export (separate change).
- Browser clients (would require subprotocol-based token transport; no v1 demand).
- Connection caps, send-buffer caps, mid-run cancellation (operator-side resource limits in v1).
- Live WS console in `/trigger/*` (form-only).
- Binary frames (JSON-only across the sandbox boundary, matching existing invariant).
- Per-connection state observable to the workflow (no connection IDs, no user identity in payload).
- Persistent connection survival across runtime restart.

## Decisions

### D1 — Per-message invocation, not per-connection handler

**Decision:** Each inbound WS frame fires the trigger handler exactly once. `open` and `close` are invisible to the workflow.

**Why:** The sandbox-reset-per-run invariant (`R-10`) means there's no place to store per-connection state across an open→messages→close arc anyway. Per-message dispatch keeps the existing handler model (`(payload) => result`), preserves the per-workflow runQueue serialization, and makes every WS invocation indistinguishable from any other trigger invocation from the executor's perspective.

**Alternatives considered:**
- *Per-connection handler with a message stream:* breaks runQueue serialization, breaks sandbox-reset-per-run, requires a deep redesign for one feature.
- *Two trigger kinds (lifecycle + message):* doubles author ceremony for marginal value when open/close are invisible anyway.

### D2 — FIFO request/reply, no `id` correlator

**Decision:** Inbound frames are processed in arrival order; each handler return is sent as a reply frame in the order it was produced. No correlation id on the wire. Clients rely on positional order.

**Why:** The per-workflow runQueue already serializes invocations one-at-a-time. Within one connection, messages naturally process in the order they arrived; replies go out in the order handlers complete. Adding an `id` correlator buys nothing the wire ordering doesn't already give us.

**Trade-off documented:** clients that need pipelined out-of-order responses must reach for HTTP. WS in this engine is strictly FIFO per-connection.

### D3 — `UpgradeProvider` is a separate interface from `TriggerSource`

**Decision:** Define `UpgradeProvider { upgradeHandler(req, socket, head): void }` as a standalone interface. The ws backend implements both `TriggerSource` and `UpgradeProvider`. `services/server.ts` accepts `upgradeProviders: UpgradeProvider[]` alongside middlewares; `main.ts` filters backends by `isUpgradeProvider` and threads the resulting list.

**Why:** Upgrade handling is orthogonal to the per-kind trigger contract. Mixing them would couple every future trigger backend (cron, imap, …) to a concept they don't need. Future fields on `UpgradeProvider` (e.g. `pingInterval`, `subprotocols`, `maxPayload`) get consumed in `services/server.ts` only — the trigger contract stays clean and `main.ts` doesn't grow.

**Alternatives considered:**
- *Add `getUpgradeHandler?(): UpgradeHandler` to TriggerSource:* couples unrelated concepts; doesn't extend cleanly.
- *Pass a flat list of upgrade-handler functions:* loses the ability to grow the interface (heartbeat config, subprotocol negotiation) without changing main.ts.

### D4 — `wss.handleUpgrade(noServer:true)` mode owned by the ws backend

**Decision:** The ws backend constructs `new WebSocketServer({noServer: true})` once at construction. Its `upgradeHandler` runs the auth check, looks up the trigger entry, and delegates to `wss.handleUpgrade(req, socket, head, ws => onConnection(ws, entry))` on success — or writes a raw `404` response on the socket and `socket.destroy()` on any failure.

**Why:** `noServer: true` is the standard `ws` library mode for "I'll own the upgrade event myself." It gives us the auth gate before any WS frames are exchanged; the alternative (`ws.WebSocketServer({server})`) couples the ws library to the http server and runs upgrades unconditionally before any auth check.

### D5 — Uniform `404` failure response

**Decision:** Every failure path (no `Authorization`, bad token, owner regex mismatch, repo regex mismatch, owner not member, workflow not found, trigger not found, trigger exists but is not a `wsTrigger`, missing `Upgrade: websocket` header) writes the same raw `HTTP/1.1 404 Not Found` response on the socket and calls `socket.destroy()`.

**Why:** Matches the existing fail-closed posture in the rest of the runtime (cross-owner 404s on `/api/*`, `/dashboard/*`). No existence/authorization information leaks to unauthenticated probes. Misconfigured-client diagnostics are sacrificed for security; logs on the runtime side capture which path failed for operator triage.

### D6 — Close codes

**Decision:**

| Code | When |
| --- | --- |
| `1000` | Client-initiated normal close (passes through). |
| `1007` | Inbound frame doesn't parse as JSON OR fails the `request` zod schema. |
| `1011` | Handler throws or returns a value that fails the `response` zod schema. |
| `1012` | Workflow re-upload removes/replaces the trigger entry. |
| `1001` | Runtime `stop()` (going away). |

The connection survives no failure. Any failure closes; the client must reconnect.

**Why:** Strict close-on-failure simplifies the wire contract — replies always correspond to successful handler runs, never to malformed input. The author can debug from the dashboard's `trigger.rejection` / `trigger.error` events.

**Trade-off:** Chat-style UIs where a single bad client message would normally be an in-band error become reconnect-after-every-bug. Acceptable for v1.

### D7 — Heartbeat as a v1 baseline

**Decision:** `pingInterval: 30_000` ms. After each ping, the next ping interval terminates the socket if no `pong` arrived. Use `ws.terminate()` (immediate socket destroy), not `ws.close()` (closing handshake the dead peer can't ack).

**Why:** Without heartbeat, half-dead clients (laptop closed, NAT dropped) accumulate forever in the connection registry. Heartbeat is ~10 lines using built-in `ws` library config. Detection window is 30–60s.

**Implementation note:** `pingInterval` is declared on the `UpgradeProvider` interface so `services/server.ts` is the only consumer that wires it (per D3). The ws backend just declares the value.

### D8 — Connection registry shape

**Decision:** In-memory `Map<scopeKey, Set<WebSocket>>` where `scopeKey = "${owner}/${repo}/${workflow}/${trigger}"`. Every incoming frame on a connection knows its scopeKey by closure binding at upgrade time; `entry.fire(input)` carries the workflow identity.

**Why:** Simplest data structure that supports the two access patterns: (a) on `reconfigure(owner, repo, entries)` the source needs to enumerate every connection whose scope's `(owner, repo)` matches and selectively keep / 1012-close based on whether the trigger remains in `entries`; (b) every send hits exactly one socket (the originator's). No cross-connection enumeration in v1 (broadcast is out of scope).

**Restart semantics:** registry is process-local. Process exit drops all connections (clients see TCP RST or `1006` abnormal close depending on shutdown path). On clean shutdown, the source's `stop()` walks the map and `close(1001)`s each socket.

### D9 — Manifest variant + dispatch source

**Decision:** Add `{kind: 'ws', name, request, response?}` to `ManifestSchema` (alongside http/cron/manual/imap). Add `'ws'` to the `DispatchMeta.source` union (alongside `'trigger'` and `'manual'`).

**Why:** Additive, mirrors how every prior trigger kind landed. Pre-existing manifests stay valid.

**`/trigger/*` UI fire:** uses `'manual'` for `meta.dispatch.source`, same as today's manual fires of any kind. WS-originated invocations (real socket) use `'ws'`.

### D10 — `{data}`-only handler payload

**Decision:** Handler payload is `{data}` only — zero metadata. No headers, no URL, no method, no user identity, no connection id.

**Why:** Authentication has happened at the upgrade gate; user identity is verified for owner-membership but not surfaced to the workflow. Other metadata (URL/method/etc.) is fixed by the WS routing convention. Authors who want correlation IDs or user identity ship it inside `data` from the client.

**Trade-off:** Authors building chat-like surfaces who DO need "who sent this message" must pass it as part of the message payload. Acceptable; matches the API-style auth model.

## Sequence diagrams

```
   Connection establishment (happy path)
   ─────────────────────────────────────
   client                  http.Server         ws backend             ws lib
     │                          │                  │                    │
     │── HTTP/1.1 GET /ws/… ───▶│                  │                    │
     │   Upgrade: websocket     │── 'upgrade' ────▶│                    │
     │   Authorization: Bearer  │   event          │                    │
     │                          │                  │ parse URL          │
     │                          │                  │ regex check        │
     │                          │                  │ Bearer + isMember  │
     │                          │                  │ registry.lookup    │
     │                          │                  │  → entry           │
     │                          │                  │── handleUpgrade ──▶│
     │◀────── 101 Switching Protocols ──────────────────────────────────│
     │                          │                  │◀──── ws ───────────│
     │                          │                  │ register(scope,ws) │
     │                          │                  │ start heartbeat    │
```

```
   Inbound frame → handler dispatch
   ─────────────────────────────────
   client          ws backend          executor          sandbox
     │                 │                   │                │
     │── frame ───────▶│                   │                │
     │                 │ JSON.parse        │                │
     │                 │ (close 1007 if    │                │
     │                 │  bad)             │                │
     │                 │ entry.fire(data)──▶ runQueue       │
     │                 │                   │  invoke ──────▶ handler
     │                 │                   │                │ result
     │                 │                   │◀───────────────│
     │                 │◀── result ────────│                │
     │                 │ validate vs       │                │
     │                 │  response schema  │                │
     │                 │ (close 1011 if    │                │
     │                 │  bad / threw)     │                │
     │◀── reply frame ─│                   │                │
```

```
   Reconfigure → 1012
   ──────────────────
   registry.reconfigure(owner, repo, newEntries)
       │
       ▼
   ws backend.reconfigure(owner, repo, newEntries):
       │
       │ for each existing connection under (owner, repo, *, *):
       │   if !newEntries.includes(its trigger):
       │     ws.close(1012, "service restart")
       │
       │ install new entries; subsequent upgrades use them
```

## Risks / Trade-offs

- [Risk: shared runQueue per workflow becomes the bottleneck for chatty WS triggers] → Documented as a known scaling profile. Authors who outgrow it should partition into multiple workflows or reach for HTTP.

- [Risk: no connection caps means a single workflow can OOM the runtime] → Operator-side resource limits (k8s pod memory) plus heartbeat liveness. Future change can add `WS_MAX_CONNECTIONS_PER_TRIGGER` env knob. Not in v1.

- [Risk: strict close-on-failure (1007/1011) makes chat-style UIs noisy] → Author trade-off: implement an in-band error envelope inside the `response` schema (`{ok: false, message}`) to keep the connection alive on logical errors; only schema-level / handler-throw failures take the connection down.

- [Risk: uniform 404 hides client misconfigurations from operators] → Mitigation: the ws backend's failure paths log structured Pino lines (`ws.upgrade-rejected` with reason) so operators can triage without exposing the reason to the client.

- [Risk: `services/server.ts` signature change ripples through main.ts and any test that constructs the server] → The signature change is additive (new positional list). Existing call sites that pass no upgrade providers behave identically. Default-empty parameter keeps the diff small.

- [Risk: `ws` library is a new runtime dep] → `ws` is the most-vetted Node WS implementation (battle-tested, MIT, near-zero transitive surface). Used by every major Node framework (Socket.IO, primus, Express+ws). Lower risk than bundling our own RFC 6455 frame parser.

## Migration Plan

- Tenants who don't use `wsTrigger` need no rebuild. The new manifest variant is purely additive.
- Tenants who add a `wsTrigger` rebuild via `pnpm build` and re-upload via `wfe upload --owner <name>`.
- No state wipe; persistence dir layout unchanged.
- Operator-visible: new env logs around `/ws/*` upgrades, new lifecycle event source `'ws'` in the dashboard. Existing dashboards filtering on `meta.dispatch.source ∈ {'trigger','manual'}` should be updated to include `'ws'` if they want WS invocations to render correctly.
- Rollback: revert the runtime image. Existing manifests with `kind:'ws'` will fail `ManifestSchema` validation on the older runtime, so rollback requires re-uploading those tenants without the WS triggers — same rollback profile as any prior additive trigger kind.

## Open Questions

None at this scope. Broadcast, browser auth (subprotocol token), connection caps, binary frames, and live WS console in `/trigger/*` are all explicitly deferred to follow-up changes.
