## Context

`/webhooks/*` is the public, unauthenticated ingress for HTTP triggers. The response is constructed by `serializeHttpResult` in `packages/runtime/src/triggers/http.ts:93-110` from the workflow handler's `HttpTriggerResult` (`{ status, body, headers }`). Today every header the workflow puts on `result.headers` reaches the wire verbatim — no allow-list, no deny-list, no platform reservation.

The 2026-04-26 typed-headers refactor closed the request-side variant of the same problem: `request.headers` defaults to `{}`, declared keys are zod-gated host-side, and the `trigger.request` event only stores validated headers. The response side was deferred.

The dangerous response-header classes:

- **Cross-tenant cookie injection.** `/webhooks/<ownerA>/...` returning `Set-Cookie: session=<attacker-blob>; Path=/` plants a cookie on the engine origin that the victim's browser then sends to `/dashboard/*` for owner B — session fixation, session DoS, or CSRF-token overwrite depending on cookie name overlap.
- **Open redirect / phishing.** Workflow returns `status: 302, headers: { location: "https://evil/" }` from a public webhook URL hosted on the engine domain. The link looks legitimate; the redirect is unconditional.
- **Platform-invariant override.** Workflow returns `headers: { "x-frame-options": "ALLOWALL" }` (or `"content-security-policy": "default-src *"`, or removes `x-content-type-options: nosniff`) and weakens the global `secureHeadersMiddleware` posture for that response.

The build+runtime split for enforcement is the spec-shaped pattern: build-time guards are developer-experience (fast feedback in the editor / CI), runtime guards are the security boundary (must hold under malicious authors and out-of-tree SDK forks).

## Goals / Non-Goals

**Goals:**

- A single, exported list of reserved response-header names lives in `@workflow-engine/core`, adjacent to `HttpTriggerResult`. Both SDK (build) and runtime import from there — one source of truth.
- Build-time: declaring a reserved name in a `response.headers` zod schema is a hard `BuildWorkflowsError` that fails `wfe upload`.
- Runtime: a workflow handler emitting reserved names has those names stripped from the wire response and produces a single `trigger.exception` row per response with the stripped names in `input.stripped`.
- Comparison is case-insensitive (HTTP header names are case-insensitive; authors may write any casing).
- The reserved list covers both the cross-tenant attack class (`Set-Cookie`, `Location`, `Refresh`, `Clear-Site-Data`, `Authorization`, `WWW-Authenticate`, `Proxy-Authenticate`) and the platform-invariant override class (`Content-Security-Policy*`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-*`, `Permissions-Policy`, `Server`, `X-Powered-By`).

**Non-Goals:**

- Renaming the platform `session` cookie to `__Host-session` (separate, larger migration).
- Per-owner webhook subdomain (`<owner>.webhooks.<engine>`) — ingress/DNS work, separate proposal.
- Adding `Content-Security-Policy: sandbox` to `/webhooks/*` responses (defense-in-depth; can land separately, doesn't change the strip surface).
- Build- or runtime-side checks on `request.headers`. The request side already defaults `payload.headers` to `{}` and zod-strips undeclared keys; an author who *declares* `authorization` is intentionally opting in to read it (their own workflow's data flow, not a platform issue).
- Allow-listing `Location` for same-origin / relative URLs. Strip outright in v1; reopen if a real use case appears. Workflows that need to redirect can return `200` with an HTML meta-refresh body or render an interstitial.
- A `Cache-Control: no-store` default on `/webhooks/*`. Workflows control caching legitimately; out of scope.

## Decisions

### D1. Reserved set lives in `packages/core/src/index.ts` next to `HttpTriggerResult`

**Decision:** Add `RESERVED_RESPONSE_HEADERS: ReadonlySet<string>` and `isReservedResponseHeader(name: string): boolean` to `packages/core/src/index.ts`, immediately after the `HttpTriggerResult` interface (line 8) and before the route regex constants (line 200). Both join the public `export {}` block at the bottom.

**Rationale:** `HttpTriggerResult` is the type whose `headers` field is being constrained — semantic adjacency makes the constraint discoverable to anyone reading the response shape. The route regexes (`OWNER_NAME_RE`, `REPO_NAME_RE`, `TRIGGER_NAME_RE`) and `httpTriggerManifestSchema` already live inline in this file as the same flavour of cross-cutting HTTP-trigger primitives.

**Alternatives considered:**

- *Separate file `packages/core/src/http-reserved-headers.ts`:* split increases grep distance; the symbol is ~25 lines including comments; `index.ts` is by design the kitchen-sink surface module (only `secrets/` is broken out, and only because it has multiple internal files).
- *In `packages/runtime`:* would force the SDK to depend on runtime, which it doesn't and shouldn't.
- *In `packages/sdk`:* would force the runtime to depend on SDK, which it doesn't and shouldn't.

### D2. Build-time enforcement in `extractHttpTriggerJsonSchemas`

**Decision:** Inside `extractHttpTriggerJsonSchemas` (`packages/sdk/src/cli/build-workflows.ts:610-645`), after the existing `toJsonSchema(trigger.response.headers, ...)` call, walk `responseHeadersJson.properties` (when defined) and call `buildContext.error(...)` for any property name that satisfies `isReservedResponseHeader`. Property name comparison is lowercased before lookup.

**Rationale:** The function already converts the response-headers zod schema to JSON Schema for the manifest. Reading `responseHeadersJson.properties.*` is one extra step on data already in hand — no second walk of the zod tree, no zod-internals introspection. Error format mirrors the existing `BuildWorkflowsError` family in this file (e.g. action name mismatch at line 402-405).

**Error message shape:**

```
Workflow "<filestem>": trigger "<exportName>".response.headers
declares reserved header "<name>". The platform owns this header on
/webhooks/* responses; remove it from the schema.
```

**Alternatives considered:**

- *AST transform plugin in the build pipeline:* parses the workflow source instead of the resolved manifest. Catches typeof-cast bypasses but adds a new Vite plugin for marginal benefit; runtime check already covers bypass cases.
- *Lint rule (Biome):* would catch the typo case but doesn't run as part of `wfe upload`. Build-time hook is the chokepoint.

### D3. Runtime enforcement: strip + single `trigger.exception` per response

**Decision:** Modify `serializeHttpResult` in `packages/runtime/src/triggers/http.ts:93-110` to partition the workflow's `result.headers` into two records (kept, reserved) before constructing the response. Pass only the kept record to `c.body(...)`. If the reserved record is non-empty, call `entry.exception(...)` once with:

```ts
{
    kind: "trigger.exception",
    name: "http.response-header-stripped",
    input: { stripped: ["set-cookie", "location"] },  // lowercased, sorted
}
```

The exception emission is fire-and-forget within the response pipeline — the HTTP response (with reserved headers stripped) returns to the caller regardless of exception persistence outcome.

**Rationale:**

- *Single exception per response (not per stripped header):* one dashboard row carries the complete picture. Authors who set five reserved headers see one entry, not five separate rows. Mirrors the IMAP per-cycle aggregation pattern from the 2026-04-26 `trigger.exception` upgrade note.
- *Strip silently was rejected (interview decision):* asymmetric behaviour vs the cross-tenant set is confusing for authors; the exception IS the value (author-fixable feedback). One unified rule.
- *Sorted, lowercased `stripped` array:* deterministic for tests and dashboard display.
- *Name `"http.response-header-stripped"`:* parallel to existing `"http.body-validation"` (line 237 in http.ts).

**Sequence (one webhook request, workflow returns reserved header):**

```
caller ──POST /webhooks/x/y/z/foo──▶ Hono
                                      │
                                      ▼
                                 httpSource.middleware.handler
                                      │ (parses URL, body, lookup)
                                      ▼
                                 entry.fire(rawInput) ──▶ executor ──▶ sandbox
                                                                          │
                                                                          ▼
                                                                  workflow handler
                                                                  returns
                                                                  { status: 200,
                                                                    headers: {
                                                                      "set-cookie":"x",
                                                                      "x-app":"v1",
                                                                    },
                                                                    body: ... }
                                      ◀────── result ──────
                                      │
                                      ▼
                                 serializeHttpResult
                                      │
                                      ├── partition headers:
                                      │     kept     = { "x-app": "v1" }
                                      │     stripped = ["set-cookie"]
                                      │
                                      ├── if stripped.length > 0:
                                      │     entry.exception({
                                      │         kind: "trigger.exception",
                                      │         name: "http.response-header-stripped",
                                      │         input: { stripped: ["set-cookie"] },
                                      │     })
                                      │
                                      ▼
                                 c.body(json, status=200, headers=kept)
                                      │
                                      ▼
                                 caller ◀── response without set-cookie
```

**Alternatives considered:**

- *Refuse to send the response (500 + `trigger.error`):* punishes the caller for the author's bug; webhook callers (e.g. payment providers) may retry indefinitely. Strip + exception preserves availability and tells the author.
- *Let the response go out and only emit the exception:* defeats the purpose of the strip; callers receive the dangerous header.
- *Per-header exceptions:* one bug → N rows, dashboard noise.

### D4. Reserved list — single combined Set, no internal sub-buckets

**Decision:** One `Set<string>` of lowercased names, no separation between "Bucket A — security-dangerous" and "Bucket B — platform invariants" at the data-structure level. Comments in the source group them for human readers.

**Rationale (interview decision):** The user pushed back on silent-override for Bucket B. With both buckets producing `trigger.exception` on strip, the runtime treatment is identical and the structural distinction adds no value. Single rule, single code path.

**The list:**

```
// Cross-tenant / external-attacker class
set-cookie
set-cookie2
location
refresh
clear-site-data
authorization
proxy-authenticate
www-authenticate

// Platform security/transport invariants
content-security-policy
content-security-policy-report-only
strict-transport-security
x-content-type-options
x-frame-options
referrer-policy
cross-origin-opener-policy
cross-origin-resource-policy
cross-origin-embedder-policy
permissions-policy
server
x-powered-by
```

`Content-Type` is **not** reserved (workflows legitimately set it; `serializeHttpResult` already has the default-injection logic at lines 84-91, 101-108).

`Cache-Control` is **not** reserved (workflows control caching).

### D5. SECURITY.md gains a "build-time/runtime parity" R-rule

**Decision:** Add a new invariant to `SECURITY.md`'s relevant section (likely §4 or a new §X):

> **NEVER** rely solely on SDK build-time validation for security boundaries on the workflow→runtime contract. The SDK runs in tenant-controlled environments and can be forked, replaced, or bypassed; every build-time guard MUST have a corresponding runtime check at the host boundary. Canonical example: `RESERVED_RESPONSE_HEADERS` is enforced both in `wfe build` (DX) and in `serializeHttpResult` (security boundary).

**Rationale:** Captures the pattern this change follows so future contributions don't regress to "build check only."

## Risks / Trade-offs

- **Risk:** Out-of-tree consumers / log-pipeline dashboards parsing for specific kinds may not yet handle `name: "http.response-header-stripped"`. → Mitigation: it's a `trigger.exception` (existing kind), not a new top-level kind; `name` strings are already extensible. Existing dashboards render exception rows generically.
- **Risk:** A workflow author *intentionally* needs `Set-Cookie` on a webhook (e.g. legacy integration). → Mitigation: this is exactly the threat we're closing; if a real use case appears, lift it via a separate proposal that scopes the cookie to a path the platform doesn't use, or moves the workflow to a per-owner subdomain.
- **Risk:** `Location` strip breaks workflows that issue redirects. → Mitigation: documented in the upgrade-notes block; alternative is a 200 + meta-refresh body. No production deployments rely on this today (response-side schemas are post-2026-04-26 and nobody is in production with reserved-header redirects in this codebase). If demand emerges, allow same-origin in a follow-up.
- **Risk:** Build-time check uses `responseHeadersJson.properties.*` keys, which only exist when the schema is an object schema. A schema like `z.record(z.string(), z.string())` (open record) would have no `properties` and the build check would not fire. → Mitigation: open-record schemas can't statically enforce *any* header keys, so the build-time check is irrelevant for them; the runtime strip remains load-bearing. Document explicitly in the spec.
- **Risk:** `entry.exception` failure (e.g. persistence outage during a strip event) crashes the runtime via the 2026-04-26 crash-on-durability-failure contract. → Mitigation: this is correct behaviour; the security action (strip) succeeds first; the durability failure is operator-visible via `runtime.fatal` and orphan recovery as designed.
- **Trade-off:** Two enforcement points means two implementations of the lookup. → Mitigation: both import the same Set from `@workflow-engine/core`; the lookup is a one-line `set.has(name.toLowerCase())` in both places. Drift risk is low.
- **Trade-off:** Strip-then-exception means the wire response is silently weaker than the workflow asked for. The caller may see HTTP-level success while the dashboard shows the exception — a split observability story. → Mitigation: this is the right trade-off — the public-webhook caller is untrusted ingress, the workflow author is the affected party, and the dashboard is where they see it. Documented in the upgrade notes.
