## Why

The runtime currently supports only one-shot trigger kinds (HTTP webhook, cron tick, IMAP poll, manual fire). There is no way for an external client to hold a live, bidirectional connection to a workflow — required for low-latency request/reply workloads (e.g. interactive tools, long-poll replacements). WebSocket fills this gap with a wire shape that aligns with the existing per-message handler model: each inbound frame is one trigger invocation, each handler return is one reply frame.

## What Changes

- **New trigger kind `ws`** with SDK factory `wsTrigger({request, response?, handler})`. Per-message invocation; handler return is sent back as a reply frame to the originating client. FIFO reply correlation (per-workflow runQueue already serializes invocations).
- **New ingress** at `/ws/<owner>/<repo>/<workflow>/<trigger>`. Authentication is `Authorization: Bearer <token>` on the upgrade request (API-style; no browser support in v1). All non-upgrade / unauthorized / unknown-trigger / non-member requests fail closed with `404 Not Found` — uniform response, no existence leak.
- **Wire close codes**: `1007` on inbound that fails the `request` zod schema; `1011` on handler throw; `1012` on workflow re-upload; `1001` on runtime shutdown.
- **Heartbeat**: 30s `pingInterval`, terminate after one missed pong. Internal mechanism — no SDK surface, no manifest field, no event emission.
- **No broadcast in v1**. Inbound replies only; no `wsBroadcast` SDK export, no `__ws` host-callable plugin. Cross-trigger fan-out is a follow-up change.
- **No connection caps in v1**. Operator-side resource limits only. Documented as a known scaling profile.
- **Connection registry** is in-memory only, keyed by `(owner, repo, workflow, triggerName)`. Restart drops all connections.
- **New `UpgradeProvider` interface** (separate from `TriggerSource`). The ws backend implements both. `services/server.ts` extends `createServer(...)` to accept `upgradeProviders: UpgradeProvider[]` alongside middlewares; each provider's `upgradeHandler(req, socket, head)` is wired to the http server's `'upgrade'` event after `serve()` binds. Keeping the interface separate leaves room to grow it (e.g. `pingInterval`, `subprotocols`) without touching the trigger contract.
- **Manifest variant**: `{kind: 'ws', name, request, response?}` joins http/cron/manual/imap in `ManifestSchema`. Author-rebuild required for tenants who want to use the new kind; tenants who don't are unaffected.
- **`/trigger/*` UI auto-renders the request-schema form** for ws triggers. Manual fire dispatches the handler in place via the existing manual path — same as cron/manual/imap. No live WS console in v1.
- **Lifecycle events** reuse existing kinds: `trigger.request` / `trigger.response` / `trigger.error` / `trigger.rejection` per message. New `meta.dispatch.source = 'ws'` literal joins `'trigger'` and `'manual'`. No new reserved event prefixes.
- **Demo update**: `workflows/src/demo.ts` gets a wsTrigger that dispatches `runDemo` (preserves the every-trigger-exercises-the-orchestrator invariant).
- **E2E test framework** gains one new chain method: `.ws(triggerName, opts?, async (sock) => …)`. `sock` exposes `send(data)` (FIFO-correlated reply), `sendRaw(string)` (1007 path), `closed` (Promise<{code, reason}>). Two e2e tests parallel test #15: protocol-adapter happy path + schema-mismatch closes 1007.

## Capabilities

### New Capabilities
- `ws-trigger`: WS protocol adapter. URL routing, upgrade authentication, per-message invocation pipeline, FIFO reply correlation, close-code policy, connection registry, heartbeat.

### Modified Capabilities
- `triggers`: New kind discriminator `ws`. New `UpgradeProvider` interface declared alongside `TriggerSource`. Backends may implement both.
- `workflow-manifest`: New manifest variant `{kind: 'ws', name, request, response?}`.
- `sdk`: New `wsTrigger({request, response?, handler})` factory. New `WS_TRIGGER_BRAND` symbol + `isWsTrigger` type guard. `Trigger` union extended.
- `trigger-ui`: `/trigger/*` form auto-renders for ws kind. Manual fire of a wsTrigger uses the manual dispatch path (no live socket); inside-handler effects (future broadcast) reach live clients.
- `http-server`: `createServer(port, opts, middlewares, upgradeProviders)` — new positional list. After `serve()` returns the http.Server, each provider's `upgradeHandler` is attached to the `'upgrade'` event. Empty list = unchanged behavior.
- `e2e-test-framework`: New chain method `.ws(triggerName, opts?, callback)`. New test-author surface symbols frozen (`Sock`, sock methods).

## Impact

**Code**
- `packages/runtime/src/triggers/ws.ts` (+ `.test.ts`) — new TriggerSource + UpgradeProvider implementation, connection registry, heartbeat, close-code policy.
- `packages/runtime/src/services/server.ts` — extend `createServer` signature; attach upgrade handlers post-bind.
- `packages/runtime/src/triggers/source.ts` — add `UpgradeProvider` interface and `isUpgradeProvider` guard (separate from `TriggerSource`).
- `packages/runtime/src/main.ts` — filter backends by `isUpgradeProvider`, thread list to `createServer`. Append `wsSource` to the backends array.
- `packages/runtime/src/executor/types.ts` (or equivalent) — `BaseTriggerDescriptor<'ws'>` arm with `request` / `response?` JSON Schemas.
- `packages/core/src/index.ts` — `ManifestSchema` gets a new variant; `DispatchMeta.source` union gains `'ws'`.
- `packages/sdk/src/index.ts` — `wsTrigger` factory, brand symbol, type guard, `Trigger` union update.
- `packages/sdk/src/cli/build-workflows.ts` — discover `wsTrigger` exports by brand; serialize manifest variant.
- `packages/runtime/src/ui/trigger-ui.tsx` (or equivalent) — render request-schema form for ws kind; route manual fire through the existing path.
- `packages/tests/src/...` — add `.ws` chain step; freeze `Sock` surface in `types.ts`.
- `packages/tests/test/<n>-ws-trigger.test.ts` — two e2e tests.
- `workflows/src/demo.ts` — add wsTrigger exercising the runDemo orchestrator.

**Dependencies**
- New runtime dep: `ws` (npm). Battle-tested, MIT, no transitive dependencies. Used in `noServer:true` mode.
- New test dep: `ws` (added to `packages/tests`). Same library on the client side.

**Manifest format**
- Additive: new variant. Pre-existing manifests remain valid. Tenants who don't use `wsTrigger` need no rebuild. Tenants who add a `wsTrigger` rebuild via `pnpm build` and re-upload via `wfe upload --owner <name>`.

**Security**
- New ingress prefix `/ws/*` requires auth on upgrade (`apiAuthMiddleware` semantics: Bearer + `isMember(user, owner)`). Identity is dropped after the gate — the workflow does not see who sent which message in v1.
- All failure modes return uniform `404` to avoid existence/authorization leak.
- No new reserved event prefix; ws lifecycle uses existing `trigger.*` kinds.
- SECURITY.md gets a new entry under §3 (public ingress is `/webhooks/*` only — `/ws/*` is authenticated) and a note that `/ws/*` MUST validate owner/repo/workflow/trigger regex + `isMember` before invoking `wss.handleUpgrade`.

**Operator-visible**
- New env knob may follow later (e.g. `WS_PING_INTERVAL_MS`); v1 hardcodes 30s.
- Re-upload force-closes existing WS connections with code 1012; clients reconnect.
- A chatty wsTrigger on a single workflow funnels all messages through the per-workflow runQueue — N clients × M msgs serialized turns. Existing constraint, but bites harder than for HTTP webhooks. Documented in design.md.

**Out of scope (v1)**
- `wsBroadcast` SDK export and `__ws` host-callable plugin (separate change).
- Connection caps and send-buffer caps.
- Mid-run cancellation on client disconnect.
- Live WS console in `/trigger/*`.
- Binary frames.
- Browser clients (no `Sec-WebSocket-Protocol` token transport).
