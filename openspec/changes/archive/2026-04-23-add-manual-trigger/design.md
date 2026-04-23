## Context

Trigger kinds today:

- `http`: ingress via `/webhooks/<tenant>/<workflow>/<name>` (public, unauthenticated by design); HTTP source owns the `/webhooks/*` route.
- `cron`: fires via per-entry `setTimeout` armed from the cron source; no HTTP ingress.

Both can also be fired from the authenticated `/trigger/<tenant>/<workflow>/<name>` UI endpoint — introduced as a kind-agnostic manual-fire path on top of the existing registry + executor machinery. That endpoint already looks up the `TriggerEntry` via `registry.getEntry(tenant, workflow, trigger)`, validates the JSON body against `descriptor.inputSchema`, and dispatches through `executor.invoke`. Session middleware + `tenantSet(user).has(tenant)` gate access.

The architectural gap this change closes: there is no trigger kind whose **only** fire path is the authenticated UI. Today, choosing "UI-invocable" necessarily means choosing HTTP (public webhook) or cron (timer). Adding `manual` gives authors a kind with no webhook and no timer — UI is the only surface.

Current invariants worth anchoring against:

- `TriggerSource<K>` contract (`packages/runtime/src/triggers/source.ts`): every registered kind has a backend that implements `reconfigure(tenant, entries)`; the registry calls `reconfigureBackends` on upload and partitions entries by kind.
- `InvocationEvent` intrinsic fields are stamped by the executor in `ensureWired` (`tenant`, `workflow`, `workflowSha`, `id`). Sandbox/plugin code never stamps these (SECURITY §2 R-8).
- Event prefixes `trigger`, `action`, `fetch`, `timer`, `console`, `wasi`, `uncaught-error` are reserved; first-party triggers use `trigger.*` (SECURITY §2 R-7).

## Goals / Non-Goals

**Goals:**

- Introduce a trigger kind with no public webhook and no timer; only the authenticated `/trigger/*` POST can fire it.
- Keep the SDK surface symmetric with `httpTrigger` / `cronTrigger` (branded callable, optional input/output schemas, handler).
- Minimise surface area: reuse registry, executor, event shape, UI form-rendering, and concurrency semantics unchanged.
- Preserve additive-change discipline: manifest schema widens; existing tenant bundles stay valid without re-upload (tenants adopting `manual` rebuild + re-upload).

**Non-Goals:**

- Per-trigger ACL beyond the existing `tenantSet(user).has(tenant)` membership check. Any authenticated user with membership in the tenant can fire any manual trigger in that tenant.
- Attributing fires to a specific user in events or logs (no `firedBy` on `InvocationEvent`, no structured log line in the POST handler).
- Rate limiting or concurrency carve-outs. Manual fires serialise through the existing per-`(tenant, workflow.sha)` runQueue identical to cron/http.
- A dashboard-level "Run" shortcut. Users go to `/trigger` and use the card like any other kind.
- A `description` field on the manifest or a subtitle/meta line in the UI card. Trigger name is the label.

## Decisions

### SDK factory shape

```ts
manualTrigger({ input?: ZodType, output?: ZodType, handler })
```

Defaults match cron: `inputSchema = z.object({})`, `outputSchema = z.unknown()`. Handler receives only the validated payload — no user identity, no URL, no headers.

**Alternatives considered:**

- Pass `{ invokedBy: { user, email } }` alongside the payload. Rejected — would require threading `UserContext` through `buildFire` and `executor.invoke`, polluting those signatures for a single kind and contradicting the principle that the fire closure is kind-agnostic.
- Forbid `input` entirely (like cron's no-payload stance). Rejected — manual triggers plausibly parameterise ad-hoc operator actions (e.g., "reprocess order #"), and making authors fake it through the handler defeats schema-driven form rendering.

### Backend shape: thin no-op `TriggerSource<"manual">`

`createManualTriggerSource()` implements the contract with:

- `reconfigure(tenant, entries)` → `Promise.resolve({ ok: true })`
- `start()` / `stop()` → `Promise.resolve()`
- no internal state

**Why not skip the backend entirely?** The registry's `reconfigureBackends` partitions entries by kind and dispatches to a registered `TriggerSource` per kind. An unregistered kind would trigger an error. Keeping a thin backend preserves the invariant that every kind has a backend, leaves room for future per-tenant state (e.g., rate-limiting windows, last-fire timestamps), and costs ~25 LOC.

**Why not a generic UiTriggerSource?** Premature — there is exactly one UI-only kind today. If a second kind appears (approval, form submission), revisit.

### No webhook ingress

The HTTP source's `/webhooks/*` route calls `registry.getEntry(tenant, workflow, trigger)` only after partitioning entries by kind. Manual entries are invisible to the HTTP source, so `/webhooks/<t>/<w>/<manual-name>` naturally 404s with no code change. The UI-only guarantee falls out structurally from kind-partitioning — it is not a separate enforcement layer that could regress.

### UI: same card, new icon

The shared kind registry is `packages/runtime/src/ui/triggers.ts`. Adding a kind is one line in each of the two maps plus a branch in `triggerCardMeta`:

```ts
KIND_ICONS.manual = "\u{1F464}"; // 👤 BUST IN SILHOUETTE
KIND_LABELS.manual = "Manual";

// In triggerCardMeta(descriptor, tenant, workflow):
if (descriptor.kind === "manual") return "";
```

`descriptorToCardData` in `page.ts` gains an explicit `kind === "manual"` branch (the existing `http` / else-is-cron shape is unsafe once a third kind exists). The branch returns:

```ts
{
  tenant, workflow,
  trigger: manual.name,
  kind: "manual",
  schema: (manual.inputSchema ?? { type: "object" }) as object,
  submitUrl: `/trigger/${tenant}/${workflow}/${manual.name}`,
  submitMethod: "POST",
  meta: "", // TriggerCardData.meta is non-optional; empty string suppresses the meta line
}
```

Jedison renders the form from `inputSchema`. The existing `schemaHasNoInputs` helper (already in `page.ts`) auto-hides the form when the schema has no properties and no additionalProperties, so manual triggers with the default `z.object({})` render as a bare Submit — no manual-specific rendering branch needed. The three-state result dialog, workflow grouping, and submit loading state contracts are all kind-agnostic today and apply to manual automatically.

### No audit identity on the event

The executor stamps `id`, `tenant`, `workflow`, `workflowSha` on every `InvocationEvent` via `ensureWired`. Adding a `firedBy?: { user, email }` field would require:

1. Threading `UserContext` from the `/trigger` POST handler into `entry.fire(input)`, and
2. Forwarding it into `executor.invoke(...)` and `ensureWired`.

That's a cross-cutting change to a kind-agnostic path for a feature that is reconstructable post-hoc (authentication access logs + timestamp correlation). Rejected for v1.

### Flow

```
┌────────────────┐   POST /trigger/<t>/<w>/<name>   ┌──────────────────┐
│  Browser form  │ ────────────────────────────────▶│ trigger-ui       │
└────────────────┘                                  │ middleware       │
                                                    └────────┬─────────┘
                                  session + isMember(user,t) │
                                                             ▼
                                                ┌──────────────────────┐
                                                │ registry.getEntry    │
                                                │ (kind-agnostic)      │
                                                └────────┬─────────────┘
                                                         │
                                    buildFire closure (input validation)
                                                         ▼
                                                ┌──────────────────────┐
                                                │ executor.invoke      │
                                                │  → runQueue          │
                                                │  → sandbox.run       │
                                                │  → trigger.*  events │
                                                └──────────────────────┘

Manual source backend on this path:  (not touched — backend is quiescent)
```

The backend participates only at upload time (`reconfigure` is called with the tenant's manual entries) and has no runtime responsibility.

## Risks / Trade-offs

- **[Risk]** A future change to the `/trigger` POST handler could accidentally broaden the fire surface (e.g., dropping the session check). → **Mitigation:** existing test coverage on `/trigger/*` enforces session-gated access; add a regression test that a manual trigger returns 401/404 without a session cookie, mirroring the pattern already used for cron.
- **[Risk]** A future change to the HTTP source's route partitioning could start matching manual entries. → **Mitigation:** add a `/webhooks/<t>/<w>/<manual-name>` 404 test to the HTTP source integration suite.
- **[Trade-off]** No `firedBy` attribution means post-hoc forensics needs log correlation. Acceptable because fires are low-volume and authentication logs already capture `(user, path, ts)`.
- **[Trade-off]** Zero-field manual triggers render as a bare Submit button (inputSchema = `z.object({})`). Visually similar to cron's "Run now"; distinguished by the different kind icon. Accepting this because the alternative (a separate "Run now" code path) fragments the UI for no user benefit.
- **[Trade-off]** The manual backend is quiescent, which means the `TriggerSource` contract test will require minimal stub assertions for this kind. Keeping the backend costs ~25 LOC but preserves the "every kind has a backend" invariant that simplifies `reconfigureBackends`.

## Migration Plan

Additive, no state wipe.

1. Merge the change.
2. Tenants adopting `manual` rebuild their workflows with the new SDK (`pnpm build` or equivalent) and re-upload via `wfe upload --tenant <name>`.
3. Tenants not using `manual` are unaffected — existing tarballs keep validating against the widened manifest schema.

**Rollback:** revert the change. Tenants who uploaded bundles containing `manual` triggers will fail manifest validation after the revert (unknown discriminant); they must re-upload a bundle without manual triggers.

## Open Questions

None. All design branches were resolved in the interview captured in `proposal.md`.
