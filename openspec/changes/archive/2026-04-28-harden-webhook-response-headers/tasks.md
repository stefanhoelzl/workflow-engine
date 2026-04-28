## 1. Core: reserved-header constant + helper

- [x] 1.1 Add `RESERVED_RESPONSE_HEADERS: ReadonlySet<string>` to `packages/core/src/index.ts`, immediately after the `HttpTriggerResult` interface. Use lowercased canonical names; include both threat-class groups (cross-tenant + platform-invariant) with a comment block separating them for human readers.
- [x] 1.2 Add `isReservedResponseHeader(name: string): boolean` next to the Set; lowercase the argument before lookup.
- [x] 1.3 Add both symbols to the public `export {}` block at the bottom of `packages/core/src/index.ts`.
- [x] 1.4 Add unit tests in `packages/core/src/index.test.ts`: exact membership of the Set, case-insensitive lookup, non-reserved names return false, `Content-Type` and `Cache-Control` are NOT reserved.

## 2. SDK: build-time rejection

- [x] 2.1 In `packages/sdk/src/cli/build-workflows.ts`, import `isReservedResponseHeader` from `@workflow-engine/core`.
- [x] 2.2 In `extractHttpTriggerJsonSchemas` (around lines 634-643), after computing `responseHeadersJson`, if the JSON Schema has a `properties` object, walk its keys; for any key whose lowercased form satisfies `isReservedResponseHeader`, call `buildContext.error(...)` with the message `Workflow "<workflowName>": trigger "<exportName>".response.headers declares reserved header "<name>". The platform owns this header on /webhooks/* responses; remove it from the schema.`
- [x] 2.3 Schemas without a `properties` object (open records) are accepted without error — the runtime check covers them.
- [x] 2.4 Add unit tests in `packages/sdk/src/cli/build-workflows.test.ts`:
    - Schema with lowercase reserved key (`"set-cookie"`) → throws `BuildWorkflowsError` mentioning the header name.
    - Schema with capitalized reserved key (`"Set-Cookie"`) → throws.
    - Schema with multiple reserved keys → throws on the first encountered (or names all; pick one and document).
    - Schema with only non-reserved keys (`"x-app-version"`) → succeeds.
    - Open-record schema (no `properties`) → succeeds.

## 3. Runtime: strip + single trigger.exception per response

- [x] 3.1 In `packages/runtime/src/triggers/http.ts`, import `isReservedResponseHeader` from `@workflow-engine/core`.
- [x] 3.2 Refactor `serializeHttpResult` so it partitions `result.headers` into `kept` and `stripped` records (lowercased name lookup) before constructing the response. Pass `kept` to `c.body(...)`. The default-`content-type` injection logic remains as-is and operates on `kept`.
- [x] 3.3 Thread access to `entry.exception` into the response-shaping path so the strip site can call it. Either:
    - extend `serializeHttpResult` to accept a `TriggerEntry`-bound exception callback, OR
    - move the strip + exception into the middleware handler (after `entry.fire(...)` returns `{ ok: true, output }`, before serialising).
    Prefer whichever fits the existing flow with the least re-plumbing; the spec contract is "exactly once per response".
- [x] 3.4 When `stripped` is non-empty, call `entry.exception({ kind: "trigger.exception", name: "http.response-header-stripped", input: { stripped: <sorted lowercased names> } })`. Fire-and-forget with respect to the HTTP response.
- [x] 3.5 Add unit tests in `packages/runtime/src/triggers/http.test.ts`:
    - Single reserved header in handler output → wire response excludes it; `entry.exception` invoked once with the header name in `input.stripped`.
    - Multiple reserved headers → single `entry.exception` call with sorted lowercased names.
    - Mixed-case reserved headers (`"Set-Cookie"`, `"LOCATION"`) → stripped; `input.stripped` is lowercased.
    - Only non-reserved headers → no `entry.exception` invocation; all headers reach the wire.
    - Status, body, and `content-type` default-injection are unchanged when reserved headers are stripped.
    - Strip occurs even when the workflow declared no `response.headers` zod schema (covers the open-record / undeclared case).

## 4. SECURITY.md update

- [x] 4.1 Add a new R-rule under the appropriate section (likely §4 or a new sub-section): `**NEVER** rely solely on SDK build-time validation for security boundaries on the workflow→runtime contract. The SDK runs in tenant-controlled environments and can be forked, replaced, or bypassed; every build-time guard MUST have a corresponding runtime check at the host boundary. Canonical example: \`RESERVED_RESPONSE_HEADERS\` is enforced both in \`wfe build\` (DX) and in the runtime HTTP \`TriggerSource\` (security boundary).`
- [x] 4.2 Add a short item to §4 (or wherever response-side hardening lives) noting that `/webhooks/*` responses strip the reserved-header list and reference the new spec requirement.
- [x] 4.3 No invariant from §1-§7 is removed by this change; do not weaken or rename existing R-rules.

## 5. CLAUDE.md upgrade note

- [x] 5.1 Append an entry under `## Upgrade notes` in `CLAUDE.md` dated today: summarise that `RESERVED_RESPONSE_HEADERS` lands in `@workflow-engine/core`, build-time rejects declared reserved keys in `response.headers` zod schemas, runtime strips reserved keys from the wire response and emits `trigger.exception` with `name: "http.response-header-stripped"` and `input.stripped`. Note that authors who currently emit `Set-Cookie`/`Location`/etc. from webhook handlers will see those values stripped silently from the wire and a new exception row in the dashboard. No state wipe; rebuild + re-upload only required for tenants who declared reserved keys in `response.headers` schemas (those builds will fail until removed).

## 6. Definition-of-done verification

- [x] 6.1 `pnpm lint` passes.
- [x] 6.2 `pnpm check` passes (TypeScript across all workspaces).
- [x] 6.3 `pnpm test` passes (Vitest unit + integration).
- [x] 6.4 `pnpm dev --random-port --kill` boots; stdout shows the ready marker.
- [x] 6.5 `POST /webhooks/local/demo/<trigger>` against a transient demo handler that returns `{ headers: { "set-cookie": "x" } }` → 200, no `Set-Cookie` on the wire, `.persistence/` event stream contains a `trigger.exception` with `name: "http.response-header-stripped"` and `input.stripped: ["set-cookie"]`. (Use a temporary fixture or a one-off variant of `demo.ts`; do not commit a permanent demo of stripping behaviour unless adding it knowingly to the canonical fixture.)
- [x] 6.6 `GET /dashboard/local/demo` (session cookie) renders an exception pill row for the stripped-header invocation.
- [x] 6.7 No cluster smoke required — change is in-process strip + build-time validation; touches `packages/core`, `packages/sdk`, `packages/runtime`, no infra/Traefik/CSP-middleware/NetworkPolicy paths.

## 7. Demo workflow alignment

- [x] 7.1 Decide whether `workflows/src/demo.ts` should add a small example of stripped-headers behaviour or leave it untouched. Default: leave untouched — demo.ts already covers the failure path via `fail`/`boom`, and adding a "deliberately-tries-set-cookie" surface bloats the file. Document the decision in the PR description.
