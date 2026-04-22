## Why

Every trigger descriptor carries an `outputSchema` (JSON Schema draft 2020-12), and every action declares an `output` Zod schema, but neither is enforced outside the sandbox. Trigger handler returns flow straight through the executor into HTTP responses and cron no-ops without ever being checked; action handler returns are validated by a guest-side closure (`(raw) => outputSchema.parse(raw)`) that the SDK itself supplies — cooperative, not defensive. The threat model states the sandbox is untrusted, so a cooperative in-guest check is not a real boundary: bugs (and, in principle, tampered bundles) can silently return garbage downstream. This change enforces both contracts host-side, where the trust boundary actually is.

## What Changes

- **SDK — extend `httpTrigger` authoring surface**: add optional `responseBody: z.ZodType` to `httpTrigger({...})`. When provided, the composed `outputSchema` makes `body` required and content-strict; when omitted, today's `{status?, body?, headers?}` envelope (Zod default, `additionalProperties: false`) is preserved. Tenants opt in to response-body enforcement by declaring it; nothing in the surface is removed.
- **Runtime — add host-side trigger output validation**: in `packages/runtime/src/triggers/build-fire.ts`, after `executor.invoke` resolves successfully, run Ajv against `descriptor.outputSchema`. On mismatch, resolve the `fire` closure with `{ok: false, error: {message: "output validation: <summary>"}}` and **no** `issues` field (existing HTTP-backend routing then correctly maps the failure to HTTP 500 — a handler bug, not a client fault). Structured per-field issues are emitted via the lifecycle event bus for dashboards/archives, not returned to the client.
- **Sandbox plugins — move action output validation host-side**: drop the `completer` parameter from `__sdk.dispatchAction`. The SDK's `action()` callable stops supplying `(raw) => outputSchema.parse(raw)`. The sdk-support plugin's dispatcher handler, after awaiting the guest `handler(input)` callable, calls a new `validateActionOutput(actionName, raw)` export from the `host-call-action` plugin (sibling to the existing `validateAction`). The Ajv-compiled output schema lives on the host, reuses the same WeakMap cache pattern as input validation, and never crosses into the sandbox. No new raw `__*` bridge is added; no new SECURITY.md R-rule is required.
- **SDK — rebuild required**: because the SDK bundle shape changes (`action()` no longer constructs a completer, `__sdk.dispatchAction` arity shrinks), existing tenant tarballs must be rebuilt and re-uploaded after deploy. No `pending/` or `archive/` wipe.

**BREAKING**: behavioural tightening. Workflows whose handlers return values inconsistent with their declared `outputSchema` begin surfacing as invocation failures (trigger side → HTTP 500; action side → throw into caller). Existing in-repo fixtures pass trivially against today's schemas (HTTP default envelope is all-optional; cron outputSchema is `z.unknown()`); tenant re-upload is required for the SDK bundle shape change regardless.

## Capabilities

### New Capabilities
<!-- None: every target capability already exists. -->

### Modified Capabilities

- `http-trigger`: add optional `responseBody` config field; document composed outputSchema shape and the strict-envelope contract.
- `payload-validation`: add requirement for trigger handler output validated host-side in `buildFire`; modify the "action output validated in-sandbox by the SDK wrapper" requirement to reflect host-side enforcement via the sdk-support plugin's bridge handler + `host-call-action` plugin's `validateActionOutput` export.
- `sandbox-sdk-plugin`: modify the dispatcher signature to drop the `completer` parameter; add the post-handler host-side output-validation step.
- `sandbox-host-call-action-plugin`: add the `validateActionOutput(name, raw)` export alongside the existing `validateAction`, using the same Ajv compile cache.
- `actions`: modify to clarify that the SDK callable no longer constructs or supplies a completer closure; output validation is framework-side, not SDK-wrapper-side.

## Impact

- **Code**: `packages/sdk/src/index.ts` (`action()`, `httpTrigger()`), `packages/sdk/src/sdk-support/index.ts` (dispatcher signature + validation step), `packages/runtime/src/plugins/host-call-action.ts` (new `validateActionOutput` export), `packages/runtime/src/triggers/build-fire.ts` (wrap executor result), `packages/runtime/src/triggers/validator.ts` (factor out `compile` helper; add `validateOutput(descriptor, output)`).
- **Sandbox boundary**: no new raw `__*` bridge added. Existing `__sdkDispatchAction` arity shrinks by one parameter. Zod runtime is still needed in the sandbox for module-load schema construction; it is no longer load-bearing for runtime action-output validation.
- **Manifests / state**: no manifest format change (`outputSchema` already ships on every trigger descriptor). No `pending/` or `archive/` wipe.
- **Tenant action**: rebuild and re-upload each tenant bundle after deploy (SDK bundle shape changes).
- **SECURITY.md**: §2 unchanged (no new raw bridge, no new `R-` rule). Payload-validation threat-model section updated to note that action output is now a host-enforced boundary rather than a cooperative in-sandbox check.
- **CLAUDE.md**: new "Upgrade notes" entry — additive behavioural tightening + SDK re-upload required.
