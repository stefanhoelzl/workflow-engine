## Why

Workflow authors sometimes want a "run this on demand" entry point that is not addressable as a public webhook and is not bound to a schedule. Today the only UI-callable triggers are `httpTrigger` (which also exposes an unauthenticated `/webhooks/<tenant>/<workflow>/<name>` ingress) and `cronTrigger` (which fires on a timer). A manual trigger closes that gap: a kind whose sole fire path is the already-authenticated `/trigger` UI, so authors can ship UI-only actions without opening a public surface.

## What Changes

- Add a new trigger kind `manual` end-to-end:
  - SDK: `manualTrigger({ input?, output?, handler })` factory, branded with `MANUAL_TRIGGER_BRAND`.
  - Manifest: `{ type: "manual", name, inputSchema, outputSchema }` discriminant (additive — existing tenant bundles remain valid).
  - Vite plugin: brand-symbol detection and manifest-entry emission alongside http/cron.
  - Runtime: `createManualTriggerSource()` — a thin no-op `TriggerSource<"manual">` (no timers, no ingress, no per-tenant state); `reconfigure` always returns `{ ok: true }`; `start`/`stop` are no-ops. Registered in the backend set so `reconfigureBackends` does not treat `manual` as an unknown kind.
  - Trigger-UI: new `KIND_ICONS.manual = "👤"` and `KIND_LABELS.manual = "Manual"` in the shared `packages/runtime/src/ui/triggers.ts` module; a `manual` branch in `triggerCardMeta` (returning an empty string — no meta line for manual); a `manual` branch in `descriptorToCardData` in `page.ts`. The existing `schemaHasNoInputs` helper already hides the form when the input schema has no fields, so manual triggers with the default `z.object({})` render as a bare Submit automatically. No changes to the `/trigger/<tenant>/<workflow>/<name>` POST endpoint itself.
- No webhook route for manual triggers (the HTTP source already partitions by kind, so `/webhooks/<tenant>/<workflow>/<manual-name>` naturally 404s).
- No new event kinds or event fields: manual fires emit `trigger.request` / `trigger.response` / `trigger.error` via the existing executor path, with no `firedBy` attribution. Session middleware on `/trigger/*` remains the sole gate.
- No breaking changes. Existing tarballs remain valid; tenants adopting `manual` rebuild and re-upload.

## Capabilities

### New Capabilities

- `manual-trigger`: SDK factory, runtime `TriggerSource<"manual">` (no-op), manifest discriminant, and UI kind registration for a trigger kind whose only fire path is the authenticated `/trigger` UI.

### Modified Capabilities

- `sdk`: adds the `manualTrigger` factory and `MANUAL_TRIGGER_BRAND` to the SDK surface.
- `workflow-manifest`: widens the trigger discriminated union with `type: "manual"`.
- `triggers`: registers `manual` as a recognised kind so `reconfigureBackends` dispatches to a manual `TriggerSource`.
- `trigger-ui`: renders `manual` kind cards with the Jedison form and a person icon.
- `vite-plugin`: detects branded `manualTrigger` exports and emits the manifest entry.

## Impact

- Code: ~280 net LOC across `packages/core`, `packages/sdk`, `packages/sdk/src/plugin`, `packages/runtime/src/triggers`, `packages/runtime/src/workflow-registry.ts`, `packages/runtime/src/executor/types.ts`, `packages/runtime/src/ui/triggers.ts` (shared kind registry), `packages/runtime/src/ui/trigger/page.ts`, plus unit/integration/contract tests.
- Manifest schema widened with a new discriminant value — additive, backwards compatible.
- No sandbox boundary change (the SDK factory is a thin callable, like cron); no plugin changes; no executor signature change; no event-shape change.
- No storage migration; no wipe of `pending/`, `archive/`, or `workflows/`.
- Tenants adopting manual triggers must rebuild with the new SDK and re-upload via `wfe upload --tenant <name>`.
