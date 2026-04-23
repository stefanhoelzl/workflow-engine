## Context

The runtime currently produces invocation events with four runtime-stamped meta fields (`id`, `tenant`, `workflow`, `workflowSha`) added at the executor's `sb.onEvent` widener (`packages/runtime/src/executor/index.ts:81-105`). These fields are stamped on **every** event for an invocation. The sandbox (worker-side) emits `SandboxEvent`s without any notion of tenant or identity — per SECURITY.md §2 R-8, tenant/id stamping is a runtime-only concern and MUST NOT leak into plugin or guest code.

Every trigger dispatch — whether from the public `/webhooks/*` ingress, a cron tick, or a click on the `/trigger/*` UI — funnels through `TriggerEntry.fire(input)` (`packages/runtime/src/triggers/build-fire.ts:27-48`) which validates input against `descriptor.inputSchema` and calls `Executor.invoke(tenant, workflow, descriptor, input, bundleSource)`. The fire closure is constructed by the registry and handed to trigger-source backends; backends call it with no knowledge of who dispatched what. The executor serializes per `(tenant, workflow.sha)`, stamps the four meta fields onto each event the sandbox emits, and forwards to the bus.

At the UI layer, the `/trigger/*` middleware (`packages/runtime/src/ui/trigger/middleware.ts`) sits behind oauth2-proxy forward-auth and `requireTenantMember`; an authenticated session is available via `c.get("user")` with fields `{name, mail, orgs}`. Today the middleware handles **non-HTTP** dispatch only — cron and future kinds. **HTTP** triggers fired from the UI page submit directly to the public `/webhooks/<tenant>/<workflow>/<name>` URL (`packages/runtime/src/ui/trigger/page.ts:132`). That ingress is deliberately unauthenticated per SECURITY.md §3 ("NEVER add authentication to /webhooks/*"). As a result, HTTP fires from the UI are indistinguishable on the server from any external webhook call — no session is read, no attribution possible.

The recently-merged `feat(ui): polish trigger + dashboard UIs` change formalized the `/trigger/*` dispatch contract as a status-class three-state envelope (2xx/4xx/5xx, JSON body always) and made the client-side submit procedure kind-agnostic: `trigger-forms.js` reads `data-trigger-url`, POSTs the Jedison form value (or `{}` for empty-schema cards), and hands the response to a shared result dialog. That machinery is compatible with rerouting HTTP fires without any client-side change — the card's `submitUrl` simply flips.

The DuckDB events table (`packages/runtime/src/event-bus/event-store.ts:55-71`) uses flat columns; `input`, `output`, `error` are the only JSON-typed columns, and they are kind-agnostic (not all kinds populate them, but the column name names the role, not the kind). There is no migration system — the table is `CREATE TABLE IF NOT EXISTS`, the in-memory DuckDB index rebuilds from archive JSON files at startup, and archive files are loaded with tolerant JSON parsing.

## Goals / Non-Goals

**Goals:**

- Make every `trigger.request` event carry a dispatch provenance blob (`{source, user?}`) that distinguishes manual UI fires from trigger-source-backed wakes and identifies the manual fire's user.
- Keep the stamping path R-8-parallel: runtime-only, executor-side, never visible or emittable from inside the sandbox.
- Reroute UI-initiated HTTP trigger fires through the authenticated `/trigger/*` endpoint so the session user can actually be attached. Leave external `/webhooks/*` behavior unchanged.
- Land the change without a state wipe: archive and pending files remain valid; legacy events load with `meta = null`.
- Keep the public SDK surface unchanged. Workflow handler code neither sees nor can affect `dispatch`.

**Non-Goals:**

- Filtering/sorting the dashboard list by dispatch source. Out of scope; the chip visually distinguishes rows but no query filter is added.
- Per-invocation details view surfacing dispatch in a dedicated panel. The flamegraph's existing trigger.request JSON tooltip surfaces it for free; a dedicated "Dispatched by" section is deferred.
- Attributing `/webhooks/*` calls to a signed-in user even when the browser would send a session cookie. §3 forbids reading auth on that path; the ingress stays truly public.
- Historical re-labeling of existing archived invocations. Provenance is forward-only.
- A new event kind or a new reserved event prefix (e.g. `invocation.dispatch`). Dispatch piggybacks on the existing `trigger.request` event as sibling meta, not as a new event.
- Any change to the manifest schema, bundle format, or sandbox plugin contract.

## Decisions

### D1. Stamp dispatch on `trigger.request` only (not on every event)

Every event of an invocation is joinable back to its `trigger.request` via the shared `id` field. The invocation has exactly one `trigger.request` by construction (the sandbox serves one run at a time; `sb.run` rejects re-entry). Duplicating `dispatch` onto every `action.*`, `timer.*`, etc. event would bloat the archive N-fold without adding information.

**Alternative considered:** Stamp `dispatch` onto every `InvocationEvent` the way `tenant`/`id` are stamped. Rejected — `tenant`/`id` are mandatory join keys that the query layer predicates on constantly, whereas `dispatch` is a rarely-read audit blob.

**Alternative considered:** Emit a separate `invocation.dispatch` event before the sandbox starts. Rejected — adds a new event kind and a new reserved prefix to SECURITY.md §2 R-7, and the information is dispatch-time static metadata that fits naturally as meta on the existing `trigger.request`.

### D2. Field name: `meta.dispatch` (nested under a generic `meta`)

Events today have three role-named generic JSON columns (`input`, `output`, `error`) that most event kinds populate selectively. A new top-level `dispatch` column would be kind-named (only `trigger.request` uses it), breaking the role-named pattern. A generic `meta` column, with `dispatch` nested inside, preserves the pattern and leaves room for future kind-specific runtime meta (e.g. per-action execution environment) without further schema churn.

On the TypeScript side, `InvocationEvent.meta?: {dispatch?: {...}}` mirrors the nested storage shape. `meta` is optional at the type level; `meta.dispatch` is optional within; `source` is required when `dispatch` is present; `user` is optional within `dispatch`.

**Alternative considered:** `dispatch JSON` column (flat, specific). Rejected on column-naming symmetry grounds.

**Alternative considered:** Three flat TEXT columns (`dispatchSource`, `dispatchUserName`, `dispatchUserMail`). Indexable for filter queries but we have no immediate need for indexed filtering; JSON extract is fine for low-cardinality admin queries, and a single generic column keeps the schema narrow.

### D3. Discriminator values: `"trigger" | "manual"`

`source: "trigger"` means the registered trigger backend fired (HTTP webhook POST, cron tick). `source: "manual"` means a person clicked the UI Submit button (regardless of whether the underlying trigger is HTTP or cron). The discriminator answers the audit question directly; the trigger kind is already recoverable from `descriptor.kind`, so we don't double-encode it.

`source` is always present on `trigger.request`; absence is not used as an implicit state. Future source values (e.g. `"replay"` for admin replays) slot in without breaking consumers.

**Alternative considered:** `"backend" | "manual"`. Initially drafted but "trigger" better reflects the runtime concept (trigger-source-backed dispatch).

### D4. Propagate dispatch through `fire(input, dispatch?)`

The `fire` closure is the single boundary every trigger source crosses when dispatching. Widening its signature to accept an optional `dispatch` keeps the concern inside the triggers layer and requires only the UI caller to supply a value (backends keep calling `fire(input)` — the default of `{source: "trigger"}` is filled in by `buildFire`).

**Alternative considered:** Two fire variants on `TriggerEntry` (`fire` + `fireManual`). Rejected — more surface, doesn't generalize to future source values.

**Alternative considered:** Stamp dispatch into a cloned descriptor. Rejected — descriptors are registry-owned immutable during a reconfigure window; mutating them per-call would break that invariant.

### D5. `Executor.invoke` refactors to an options bag

Current signature `invoke(tenant, workflow, descriptor, input, bundleSource)` is already 5 params; adding a 6th (`dispatch`) pushes into the "options bag" territory. Refactor to `invoke(tenant, workflow, descriptor, input, {bundleSource, dispatch?})`. Future invocation-time knobs (e.g. priority hints) slot into the bag without another signature churn.

Executor stores `dispatch` alongside the four identity fields in `activeMeta` (per-sandbox, set synchronously before `sb.run`, cleared after). The widener reads `activeMeta` for every sandbox event; it gates on `event.kind === "trigger.request"` and attaches `meta: {dispatch}` only for that one kind.

### D6. Reroute UI HTTP fires through `/trigger/*`; server-side payload wrapping

The `/trigger/*` handler becomes kind-aware. For `descriptor.kind === "http"`, it synthesizes:

```
{body: <posted JSON>, headers: {}, url: "/webhooks/<tenant>/<workflow>/<name>", method: descriptor.method}
```

and calls `fire(payload, dispatch)`. The payload is then validated against `descriptor.inputSchema` inside `buildFire` just like a real webhook call.

The UI page (`page.ts`) flips the HTTP card's `submitUrl` from `/webhooks/<t>/<w>/<n>` to `/trigger/<t>/<w>/<n>`. The existing `meta` chip text (e.g. `"POST /webhooks/..."`) is preserved — it still communicates the public URL external callers would use. Client-side `trigger-forms.js` needs no change: it already POSTs `formValue` to `data-trigger-url` and routes the response through the three-state dialog.

External webhook callers continue to hit `/webhooks/*` and emit `source: "trigger"`.

**Headers = empty, URL = relative webhook path:** the synthesized payload intentionally carries minimal envelope. Setting `content-type` would leak dispatch-path-specific meta into a guest-visible field. Using a relative URL avoids host/scheme ambiguity across environments; workflow handlers that care about absolute URLs already parse `new URL(payload.url)` at their own risk.

### D7. No-session open-mode dev still emits `source: "manual"`

`/trigger/*` has an open-mode dev fallback when no session is present (`middleware.ts:43-52`). In that path, the fire is still manual (someone clicked the UI button); we emit `source: "manual"` with `user` omitted. Dashboard chip renders as "manual" with no name. This keeps the invariant "any fire through /trigger/* → source=manual" intact and doesn't require splitting into a dev-only code path.

### D8. Schema & archive loader forward-only

Add the `meta JSON` column via `CREATE TABLE IF NOT EXISTS` (fresh rebuild on next process start — no migration needed; the in-memory DuckDB index rebuilds from archive files anyway). Archive serialization emits `meta` as an optional top-level JSON field. The archive loader tolerates its absence: legacy archived invocations load with `meta = null` everywhere, including on their `trigger.request` events. No state wipe required.

## Cross-component flow

```
UI browser                                           Server
┌─────────────────┐   POST /trigger/<t>/<w>/<n>    ┌──────────────────────────┐
│ trigger-forms.js│ ───── body = formValue ──────▶ │ /trigger middleware      │
│ click Submit    │                                │  requireTenantMember     │
└─────────────────┘                                │  lookup descriptor       │
                                                   │  if kind=http: wrap body │
                                                   │  build dispatch from    │
                                                   │   session user          │
                                                   │  fire(input, dispatch)  │
                                                   └───────────┬──────────────┘
                                                               │
                                                   ┌───────────▼──────────────┐
                                                   │ buildFire                │
                                                   │  validate(inputSchema)   │
                                                   │  executor.invoke(...,    │
                                                   │    {bundleSource,        │
                                                   │     dispatch})           │
                                                   └───────────┬──────────────┘
                                                               │
                                                   ┌───────────▼──────────────┐
                                                   │ Executor.runInvocation   │
                                                   │  activeMeta.set(sb, {    │
                                                   │    id, tenant, workflow, │
                                                   │    workflowSha, dispatch}│
                                                   │  sb.run(name, input)     │
                                                   └───────────┬──────────────┘
                                                               │ sandbox emits
                                                               │ trigger.request
                                                               ▼
                                                   ┌──────────────────────────┐
                                                   │ sb.onEvent widener       │
                                                   │  id/tenant/... stamped   │
                                                   │  if kind === "trigger.   │
                                                   │     request":            │
                                                   │    meta: { dispatch }    │
                                                   │  bus.emit(InvocationEvent│
                                                   └───────────┬──────────────┘
                                                               ▼
                                                         Event consumers
                                                         (archive, logging,
                                                          event-store,
                                                          work-queue)
```

External `/webhooks/*` POSTs enter via the HTTP trigger source, which calls `fire(payload)` with no dispatch argument — `buildFire` defaults to `{source: "trigger"}` and the rest of the flow is identical.

## Risks / Trade-offs

- **Risk:** Forgetting to gate the widener on `event.kind === "trigger.request"` would leak `meta.dispatch` onto every event → archive bloat. **Mitigation:** Executor unit test asserts `meta` is present only on `trigger.request` and absent on other kinds for the same invocation.

- **Risk:** A future contributor adds `meta` stamping in a plugin, violating the new R-rule. **Mitigation:** SECURITY.md §2 adds an explicit R-rule; CLAUDE.md's invariants list gains the matching NEVER line. Plugin boundary is also enforced by `assertSerializableConfig` (existing) plus the fact that plugins emit via `ctx.emit` which routes through `bridge.*` — `meta` simply has no entry point from the sandbox side.

- **Risk:** Rerouting UI HTTP fires changes the observable payload — external-caller-style headers that workflows might be relying on (`user-agent`, `content-type`, etc.) will now be empty when fired from the UI. **Mitigation:** This is a behavior change for workflows that read `payload.headers`. Acceptable trade-off: the old `/webhooks/*` path is still available to external callers; workflows that need realistic headers still get them from real webhook callers. Document in upgrade notes.

- **Risk:** Legacy archive files without `meta` are rendered inconsistently in the dashboard (no chip, no tooltip). **Mitigation:** This is the forward-only expected behavior; the dashboard renders the absence as "no chip", matching `source: "trigger"`. The flamegraph tooltip already renders event JSON blob as-is; missing `meta` just means no extra line.

- **Trade-off:** The `meta JSON` column is deliberately generic to keep the schema symmetrical, but it creates a mild search-ergonomics penalty: queries filtering by `source` must JSON-extract. For current use (dashboard list of recent invocations + hand-query), this is fine; if indexed filtering becomes necessary later, we can add a computed column or promote fields.

- **Trade-off:** `source="manual"` conflates all UI-originated fires, even in open-mode dev where the "user" is effectively anonymous. The chip will display "manual" (no name) for dev fires; operators can tell by absence of a name. Not worth a third discriminator value for the dev edge case.

## Migration Plan

Forward-only, no state wipe:

1. Deploy the change. On process start:
   - DuckDB table is re-created with the new `meta` column (`CREATE TABLE IF NOT EXISTS` is a no-op for existing schemas but the index is rebuilt in-memory from archive on every start anyway).
   - Archive files without `meta` load with `meta = null`.
2. Existing invocations in archive are displayed on the dashboard with no chip (equivalent to `source: "trigger"`).
3. New invocations: UI fires produce `source: "manual"`; external webhook + cron produce `source: "trigger"`.

**Rollback:** revert the change. The `meta JSON` column in DuckDB is in-memory-only (rebuilt on every start); no persistent schema cleanup needed. Archive files with `meta` entries written during the incident are loaded by the old code with no `meta` field (JSON deserialization simply ignores unknown keys — confirm the pre-change archive loader is tolerant; add a test to lock this in during implementation). The UI's HTTP card submit URL reverts to `/webhooks/*` automatically.

## Open Questions

None. All design branches resolved during the interview.
