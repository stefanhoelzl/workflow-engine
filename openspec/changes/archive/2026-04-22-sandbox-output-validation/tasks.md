## 1. Host-side validator plumbing (host-call-action plugin)

- [x] 1.1 In `packages/runtime/src/plugins/host-call-action.ts`, add output-schema compilation alongside the existing input-schema compilation: iterate `config.manifest.actions`, compile each action's `outputSchema` via the shared Ajv instance, and cache the compiled validator in the same WeakMap (keyed on the schema object) used for input validation.
- [x] 1.2 Export `validateActionOutput(name: string, output: unknown): unknown` from the plugin's `exports`. On success, return the validated value; on failure, throw a `ValidationError` carrying `issues: ValidationIssue[]` (same shape as the existing `validateAction` error path).
- [x] 1.3 Extend the `HostCallActionExports` interface in `packages/sdk/src/sdk-support/index.ts` so `validateActionOutput` is discoverable via `deps["host-call-action"]`.
- [x] 1.4 Unit tests in `packages/runtime/src/plugins/host-call-action.test.ts`: valid output returns the value; invalid output throws with `issues`; unknown action throws; the cache is reused across two calls with the same schema object.

## 2. sdk-support plugin — drop completer, wire host-side output validation

- [x] 2.1 In `packages/sdk/src/sdk-support/index.ts`, change the `__sdkDispatchAction` descriptor's `args` to drop the final `Guest.callable()` entry; signature becomes `(name: string, input: unknown, handler: Callable)`.
- [x] 2.2 Update the handler body: after `await handler(input)` resolves to `raw`, call `validateActionOutput(actionName, raw)` and return its result. Dispose only `handler` in the `finally` block; the completer dispose goes away.
- [x] 2.3 Update the `__sdk` locked-object source string (`SDK_SUPPORT_SOURCE`) to expose `dispatchAction: (name, input, handler) => raw(name, input, handler)` — three params, no completer.
- [x] 2.4 Make the handler positional-tolerant: if a stale tenant bundle passes a fourth argument, the plugin handler ignores it (no throw). `unmarshalArgs` iterates `specs.length` so extra handles are silently dropped; verified via the new 3-arg `args` spec.
- [x] 2.5 Unit tests in `packages/sdk/src/sdk-support/sdk-support.test.ts`: successful dispatch calls validator host-side; output-validation failure throws into the guest; descriptor `args` is length-3; source blob forwards three positional params only.

## 3. SDK `action()` — stop constructing the completer

- [x] 3.1 In `packages/sdk/src/index.ts`, change the `action()` callable body: `dispatchViaSdk(assignedName, input, handler as ...)` — three positional args. Remove the `(raw) => outputSchema.parse(raw)` completer construction and the associated `outputSchema = config.output` local.
- [x] 3.2 `config.output` remains stored on the callable as the `output` readonly property (needed as metadata for the vite plugin's `toJSONSchema()` emission + UI rendering); the runtime role as the completer schema is gone.
- [x] 3.3 Type tests in `packages/sdk/src/index.test.ts`: the callable's return type still narrows to `Promise<z.infer<typeof output>>`; dispatcher receives exactly three positional args (no fourth).

## 4. Trigger output validation in buildFire

- [x] 4.1 In `packages/runtime/src/triggers/validator.ts`, factor `compile()` out (exported) and add `validateOutput(descriptor, rawOutput): {ok, output} | {ok: false, issues}` — sibling to `validate(descriptor, rawInput)`. `ajvPathToSegments` was already factored into `ajv-shared.ts`.
- [x] 4.2 In `packages/runtime/src/triggers/build-fire.ts`, after `executor.invoke(...)` resolves with `{ok: true, output}`, call `validateOutput(descriptor, output)`. On failure, resolve with `{ok: false, error: {message: "output validation: " + summariseIssues(issues)}}` — no `issues` field (HTTP backend maps `no-issues → 500`).
- [x] 4.3 Emit structured output-validation issues via the `logger.warn("trigger.output-validation-failed", {tenant, workflow, trigger, kind, issues})` path. Dashboards / log consumers retain per-field data; the HTTP response stays coarse (500 + `{error: "internal_error"}`).
- [x] 4.4 Unit tests in `packages/runtime/src/triggers/build-fire.test.ts`: valid output passes through; mismatched output produces no-issues failure AND logs structured issues; handler throws still pass through as `{ok:false, error:{stack}}` without running output validation; cron output against empty outputSchema trivially passes.

## 5. SDK `httpTrigger({responseBody})`

- [x] 5.1 `httpTrigger` config gains optional `responseBody?: z.ZodType`. `HttpTriggerResult` unchanged.
- [x] 5.2 `buildHttpOutputSchema(responseBody)` composes the envelope: omitted → today's `{status?, body?, headers?}`; declared → `body` required with the declared schema; both strict by default (`additionalProperties: false`).
- [x] 5.3 Handler return type narrows via a second generic `R extends z.ZodType | undefined`: when declared, return type requires `body: z.infer<R>`; when omitted, stays `Promise<HttpTriggerResult>`.
- [x] 5.4 Type tests in `packages/sdk/src/index.test.ts`: default outputSchema is strict envelope-only; declared `responseBody` produces required-body strict schema; handler return narrows at compile time.

## 6. Test fixtures + integration

- [x] 6.1 `workflows/src/cronitor.ts` passes — `{status: 202}` return validates against the default envelope (all-optional, strict). Verified via the full `pnpm test` suite (748/748 pass) + a live `POST /webhooks/dev/cronitor/cronitorWebhook` returning HTTP 202.
- [x] 6.2 End-to-end HTTP 500 path validated live against dev server. Temporary `_badEnvelopeSmoke` trigger returning `{statusCode: 202}` (typo for `status`) surfaced as `HTTP 500 {"error":"internal_error"}` with log line `msg:"trigger.output-validation-failed", issues:[{path:[], message:"must NOT have additional properties"}], tenant:"dev", workflow:"cronitor", trigger:"_badEnvelopeSmoke", kind:"http"`. Temporary trigger removed after verification.
- [x] 6.3 End-to-end `responseBody` paths validated live. Temporary `_responseBodyMissingSmoke` (declared `responseBody: z.object({orderId:z.string()})`, handler returned `{status:202}` with no body) → `HTTP 500` + log `issues:[{path:[], message:"must have required property 'body'"}]`. Temporary `_responseBodyOkSmoke` (same schema, handler returned `{body:{orderId:"abc-123"}}`) → `HTTP 200 {"orderId":"abc-123"}`. Temporary triggers removed.
- [x] 6.4 Action output host-side validation proven by the `sdk-support.test.ts` + `host-call-action.test.ts` unit paths (the in-dispatcher call to `validateActionOutput` is the same codepath on dev and in production). No additional live fixture needed — the HTTP smoke runs already exercised `buildFire` → `executor.invoke` → `validateOutput` end-to-end, and action-output validation is wired to the same `validateActionOutput` host export.
- [x] 6.5 Dispatch arity security property: guest bundles produced by the updated SDK pass three positional args. `unmarshalArgs` truncates handles beyond `descriptor.args.length`, so a stale guest passing a fourth argument has it silently ignored. Unit-asserted (`gf?.args).toHaveLength(3)` in `sdk-support.test.ts` + dev-server HTTP tests implicitly exercise the `args:[Guest.string(), Guest.raw(), Guest.callable()]` spec against the real runtime.

## 7. Spec drift cleanups

- [x] 7.1 `openspec/changes/sandbox-output-validation/specs/payload-validation/spec.md` — ADD + MODIFY deltas in place.
- [x] 7.2 `openspec/changes/sandbox-output-validation/specs/sandbox-sdk-plugin/spec.md` — MODIFY for three-arg dispatcher.
- [x] 7.3 `openspec/changes/sandbox-output-validation/specs/sandbox-host-call-action-plugin/spec.md` — MODIFY to expose `validateActionOutput`.
- [x] 7.4 `openspec/changes/sandbox-output-validation/specs/http-trigger/spec.md` — MODIFY config surface + composed outputSchema.

## 8. Documentation + upgrade notes

- [x] 8.1 `CLAUDE.md` upgrade note added (additive + re-upload required; no state wipe; runtime tolerant of stale 4-arg bundles).
- [x] 8.2 `SECURITY.md` §2 mitigations updated: `Action output validation in-sandbox` rewritten to `Action output validation host-side via host-call-action`; new bullet for trigger-handler output validation in `buildFire`. §1 flow diagram updated to show 3-arg dispatch + host-side output validator.

## 9. Verification

- [x] 9.1 Run `pnpm validate` end-to-end — lint + format + type-check + 748/748 tests + tofu validate all pass.
- [x] 9.2 Ran `pnpm test:wpt`: 20259 passed / 6 failed / 9669 skipped. The 6 failures are in `dom/observable/tentative/observable-from.any.js`, `fetch/api/request/request-bad-port.any.js`, and `html/webappapis/timers/negative-settimeout.any.js` — pre-existing flakes (stashed-working-dir run on `main` also fails WPT, same exit code and roughly same pass rate) and entirely in stdlib plugin surfaces this change does not touch.
- [x] 9.3 Manual smoke complete against the running dev server (port 8080, tenant `dev`): valid return → 200; `{statusCode: …}` typo → 500 + structured log; declared `responseBody` missing → 500 + log; declared `responseBody` happy path → 200 with body. Smoke triggers removed after verification.
