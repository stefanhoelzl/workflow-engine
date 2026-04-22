## Context

Every trigger descriptor carries `outputSchema: Record<string, unknown>` (JSON Schema draft 2020-12, populated from tenant Zod schemas by the vite plugin), and every action has a Zod `output` schema captured on its callable at build time. After the `generalize-trigger-backends` and `sandbox-plugin-architecture` changes landed:

- Trigger handler output is never consulted against `outputSchema` — it flows from `sb.run` through the executor into `InvokeResult.output` and on to the HTTP backend's `serializeHttpResult`, or is discarded by the cron backend. No enforcement path exists.
- Action handler output is validated *inside* the sandbox by a guest-supplied completer closure: the SDK's `action()` constructs `(raw) => outputSchema.parse(raw)` and passes it as the fourth parameter to `__sdk.dispatchAction`. The sdk-support plugin's dispatcher handler calls `await completer(raw)` before returning. The validation runs in QuickJS, against a schema the guest itself supplies.

The security section of the project (`SECURITY.md`) treats the sandbox as untrusted: tenant code, bundles, and anything else executing in QuickJS is outside the trust boundary. A cooperative in-guest validator is therefore not a real contract boundary — a malicious or buggy bundle can supply a lenient completer, or the in-guest Zod instance can be shadowed, or future changes to the SDK bundle can silently weaken the check. The host-side manifest knows the ground-truth schema; validation belongs there.

## Goals / Non-Goals

**Goals:**
- Enforce `descriptor.outputSchema` against the trigger handler's return, host-side, before `fire` resolves.
- Move action-output validation out of the sandbox entirely, running host-side in the sdk-support plugin's bridge handler.
- Keep the existing HTTP-backend routing rule (no `issues` → 500) correct without widening the `InvokeResult` failure shape.
- Surface structured per-field validation errors on the lifecycle event bus so dashboards / archives / logs retain actionability.
- Extend the SDK surface to let tenants declare response-body schemas (`httpTrigger({responseBody})`) so the enforcement has something useful to enforce beyond the envelope shape.

**Non-Goals:**
- Do not remove Zod from the sandbox. Zod's `z.X(...)` constructors must still run at module load to build the schema objects the SDK's metadata captures. Stripping Zod is a separate plugin-rewrite change.
- Do not redesign `executor.invoke` or `TriggerSource.reconfigure`. Both are kind-agnostic today; the new behaviour hooks in at `buildFire` (trigger side) and at the sdk-support plugin's existing bridge handler (action side).
- Do not introduce a new raw `__*`-prefixed global to the sandbox. The action-side change extends `host-call-action`'s existing peer-plugin interface; no new SECURITY.md §2 rule is needed.
- Do not address event-archive integrity. `SandboxEvent.input` / `SandboxEvent.output` are synthesised host-side by the plugin framework from bridge observations, so there is no separate "guest forges archive event" risk — but any future work that lets the guest supply event fields directly is out of scope here.
- Do not extend `InvokeResult` with new fields (no `code` discriminant, no `output_issues` field). The existing shape is sufficient once we decide that output-validation failures are morally delayed throws.
- Do not validate cron output beyond what the cron backend already discards. Cron's `outputSchema` is `z.unknown()` today (empty object schema that matches everything); validation runs but cannot fail. We keep it running for consistency and so a future tenant-declared cron output schema is enforced automatically.

## Decisions

### D1. Trigger output validation lives in `buildFire`, not the executor

`packages/runtime/src/triggers/build-fire.ts` already wraps the executor with input validation and returns an `InvokeResult` envelope to each backend. That is the correct insertion point: it already owns the `descriptor` and the `InvokeResult`, it already surfaces validation failures via the `fire` contract, and no other component needs to change.

```
  Shape of the new buildFire closure
  ─────────────────────────────────────────────────────────
  return (input) => {
    const v = validate(descriptor, input);
    if (!v.ok) {
      return Promise.resolve({ok: false, error: {
        message: "payload_validation_failed",
        issues: v.issues,
      }});
    }
    return executor.invoke(...).then((result) => {
      if (!result.ok) return result;  // handler throw — passthrough
      const vout = validateOutput(descriptor, result.output);
      if (vout.ok) return result;
      return {ok: false, error: {
        message: "output validation: " + summariseIssues(vout.issues),
      }};  // NO issues field — routes to 500 in HTTP backend
    });
  };
```

**Alternative considered: validate inside the executor.** Rejected because the executor already receives an `InvokeResult`-shaped result from `sandbox.run`, and adding another failure source there couples the executor to schema semantics it otherwise has no reason to know about. `buildFire` already is that layer.

### D2. Output-validation failures carry a plain message, not `issues`

The HTTP backend's current routing rule is:

```
  result.ok = false, error.issues present  →  HTTP 422   (client fault)
  result.ok = false, error.issues absent   →  HTTP 500   (server fault)
  result.ok = true                         →  handler-chosen status
```

The rule works today because `issues` is only attached to the one failure class that is always client-caused: input validation (pre-handler). Output validation is the opposite — it fires *after* the handler returns, catches a handler bug, and is morally a delayed throw. HTTP 500 is the right response; a 422 would blame the client for a server-side contract violation.

Rather than add a `code` discriminant to `InvokeResult.error`, we respect the existing invariant: output-validation failures omit `issues`. A compact one-line summary ("output validation: /body/status: must be number") goes in `error.message`; the existing HTTP backend switch routes it to 500 with no change.

**Alternative considered: add `error.code` as an enum discriminant.** Rejected because the existing two-value routing suffices; widening the type is disproportionate to the benefit, and the observational data we would otherwise put in `issues` already flows through the lifecycle event bus, where dashboards can subscribe without touching the HTTP response.

**Alternative considered: add `error.output_issues` as a parallel field.** Rejected as strictly worse than D2's choice — it widens the type, adds a parallel structure with the same shape as `issues`, and still needs documentation of which means what.

### D3. Structured output-validation issues survive via the event bus

Dashboards, archives, and logs must not lose structure even though the HTTP response does. The executor's existing `sb.onEvent` receiver already widens every `SandboxEvent` into an `InvocationEvent` and fans out via the bus. This proposal adds an `invocation.output-validation-failed` emit from `buildFire` when output validation fails, carrying the full `ValidationIssue[]` as a field on the event. The HTTP response stays coarse (500 with a short message); the observability surface stays rich.

### D4. Drop the `completer` parameter from `__sdk.dispatchAction`

The sdk-support plugin's current bridge handler signature is:

```
  handler: async (actionName, input, handler: Callable, completer: Callable) => {
    validateAction(actionName, input);
    const raw = await handler(input);
    return await completer(raw);   // in-guest Zod parse
  }
```

Under the host-side validation model, `completer` becomes dead weight: the host already has the ground-truth Zod schema on `ActionDescriptor.output`, so the guest has nothing to supply. The new signature is:

```
  handler: async (actionName, input, handler: Callable) => {
    try {
      validateAction(actionName, input);
      const raw = await handler(input);
      return validateActionOutput(actionName, raw);   // host-side
    } finally {
      handler.dispose();
    }
  }
```

`validateActionOutput(name, raw)` is a new export of the `host-call-action` plugin, sibling to the existing `validateAction(name, input)`. It uses the same Ajv compile cache pattern (WeakMap keyed on the schema object) and returns the parsed value or throws a `ValidationError` carrying `issues` — the same shape existing input-validation errors already cross the bridge with.

**Security consequence:** the guest can no longer influence what validation runs. A tampered SDK cannot substitute a lenient `completer`, because there is no longer a completer parameter. The schema lives entirely on the host.

**Bridge round-trip cost:** zero extra. Today's dispatcher already awaits the `handler(input)` Callable, which crosses the bridge to invoke the guest handler and returns a value back. `validateActionOutput` runs in the same bridge-handler turn, host-side, before the handler resolves to the caller — no second round trip.

**Alternative considered: a new `__hostValidateActionOutput` raw bridge (pre-rebase B-ii).** Rejected now because the plugin architecture already provides the necessary abstraction: the sdk-support plugin's dispatcher runs host-side and can invoke a peer-plugin's host-side export directly. No new `__*` global, no new SECURITY.md §2 R-rule.

**Alternative considered: keep the completer but make it a host-provided Callable.** Rejected: the abstraction exists purely for historical reasons (an in-guest `outputSchema.parse(raw)` path). With validation host-side and the schema already reachable from the plugin peer-dep map, the parameter adds no expressiveness.

### D5. `httpTrigger({responseBody})` — optional, strict-when-declared

The pre-rebase SDK surface is `httpTrigger({method?, body?, handler})` (post-`fix-http-trigger-url`). Adding `responseBody?: z.ZodType` as a fourth optional field is a one-line extension to the config type.

- **Omitted** (default): `outputSchema` is the existing `z.object({status?, body?, headers?})` module-level constant. Zod's `toJSONSchema()` defaults emit `additionalProperties: false` at the envelope — strict already. This catches typos like `statusCode` or `response`, and is `cronitor.ts`-compatible because that fixture returns `{status: 202}` with no extra fields.
- **Declared**: `outputSchema = z.object({status?: number, body: responseBody, headers?: Record<string,string>})` — `body` required, `body` strict to whatever the tenant declared. No `.loose()` anywhere; tenants who want a passthrough body opt in explicitly via `z.object({...}).loose()` on their own schema.

**Ergonomics note.** Declaring `responseBody` makes status-only responses (e.g. `return {status: 202}` with no body) no longer expressible — `body` is required. Tenants that need that pattern either keep `responseBody` undeclared or model the absent body explicitly (`responseBody: z.null()` and return `{status: 202, body: null}`). This is the intended contract: if you declare a body schema, you are promising a body.

**Alternative considered: `.loose()` envelope by default.** Rejected — see "Thread 3" in design history. Envelope is a three-key runtime contract (`status`/`body`/`headers`); anything else is silently dropped by `serializeHttpResult` today. Strict turns silent drops into loud validation errors, which is the whole point.

### D6. Cron output validation runs but cannot fail (today)

Cron's outputSchema is the JSON Schema form of `z.unknown()` — an empty object that matches everything. `buildFire` runs output validation uniformly across trigger kinds; cron validation is a no-op in practice because the schema is permissive. This is deliberate: once a future SDK change lets tenants declare a cron output schema (or once a downstream consumer defines one), the enforcement path is already wired. No special case for cron.

### D7. Opportunistic cleanup of drifted spec text

The rebased code exposes three pre-existing drifts in spec text:

- `openspec/specs/payload-validation/spec.md` — "Action output validated in-sandbox by the SDK wrapper" describes the pre-plugin-architecture in-sandbox `.parse()` call, which is already obsolete (it's now a host-injected completer after the rebase; after this change it is host-side validation with no completer at all). We rewrite it.
- `openspec/specs/actions/spec.md` — same stale "SDK wrapper calls `.parse()`" language. We update to the new framework-side validation model.
- `openspec/specs/sandbox-sdk-plugin/spec.md` — dispatcher arity drops. We update to the three-arg shape.

We do **not** attempt to fix every other drift in the specs tree in this proposal. The executor spec's stale `invoke(..., triggerName, payload)` on line 9 vs `descriptor, input, bundleSource` on line 98 is left alone (different capability, not touched by this change's code).

## Risks / Trade-offs

**[Risk] Tenant bundles that violate `outputSchema` today silently propagate garbage; after this change, they fail loudly.**
→ Mitigation: the in-repo fixture (`workflows/src/cronitor.ts`) returns `{status: 202}` and passes trivially against the default strict envelope; every new HTTP handler is type-checked against `HttpTriggerResult` so the schema and the handler's type already agree at build time; the upgrade note is explicit that this is a behavioural tightening.

**[Risk] The bridge-handler turn now runs a synchronous JSON validation between the guest handler's resolve and the caller's resume; a very large action output amplifies per-call cost.**
→ Mitigation: Ajv compile is cached (WeakMap keyed on the schema object); run time is linear in the output size. The same cost is paid today by the in-guest `outputSchema.parse(raw)` call, so net latency delta is near zero. Where it differs: the work is in Node (Ajv/JSON Schema) instead of QuickJS (Zod) — slightly faster in practice.

**[Risk] A re-upload is required because the SDK bundle shape changes (the `action()` callable no longer supplies a completer); tenants who skip the re-upload step will run with a stale SDK that still passes four arguments.**
→ Mitigation: the upgrade note in `CLAUDE.md` is explicit; the new dispatcher ignores the fourth argument if present (backwards-tolerant signature: `async (actionName, input, handler, _ignored?) => ...`), so a lagging bundle falls through cleanly — validation is still enforced host-side regardless of what the guest passes. This keeps the security property intact even for stale bundles.

**[Risk] HTTP-backend callers that currently receive a 200 + malformed body will start receiving 500 after this change — an upstream monitoring / alerting surface change.**
→ Mitigation: flagged in the CLAUDE.md upgrade note; operators reviewing alerts will see failed invocations in the dashboard with the `output validation` message and can locate the offending handler.

**[Trade-off] We accept that output validation reports via the event bus, not the HTTP response, losing structured per-field feedback from the caller's perspective.**
→ Rationale: output validation failures are server-side bugs, not client-actionable. Issuing a 500 with a short message matches HTTP semantics. Per-field details land in the invocation archive and the dashboard, where operators (not callers) consume them.

**[Trade-off] We keep Zod runtime in the sandbox, even though runtime validation no longer uses it.**
→ Rationale: the SDK bundle evaluates `z.object({...})` at module load to construct schema objects that the vite plugin reads for JSON-Schema emission + that the SDK's action/trigger metadata stores for the UI. Removing Zod is a plugin-rewrite concern; out of scope here.

## Migration Plan

**Pre-deploy:** none.

**Deploy sequence:**
1. Merge this change to `main`; CI builds and publishes the new runtime image.
2. Staging deploys automatically (push to `main` triggers `.github/workflows/deploy-staging.yml`). The runtime goes live; existing tenant bundles still work because the new dispatcher is signature-tolerant (see Risks).
3. Rebuild + re-upload each tenant bundle via `wfe upload --tenant <name>`. This produces bundles whose `action()` callables no longer supply a completer. After re-upload, the dispatcher sees the three-argument form and validation runs host-side.
4. Promote to `release` branch to roll to production.

**Rollback:** `git revert <bad-sha>` on the release branch. Old runtime image still understands old bundles. No state wipe is needed because no manifest or persistent storage shape changes.

**No-op for:** `pending/`, `archive/`, storage backend, persistence bucket, K8s state, secrets.
