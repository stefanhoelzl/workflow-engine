## 1. SDK surface (`packages/sdk`)

- [x] 1.1 Restructure `httpTrigger` factory in `packages/sdk/src/index.ts:341` to grouped config: `{ method, request?: { body?, headers? }, response?: { body?, headers? }, handler }`. `method` stays top-level.
- [x] 1.2 Update generics so `request.body` (default `z.any()`), `request.headers` (default empty Zod object), `response.body` (default absent), `response.headers` (default absent) flow into `HttpTriggerPayload<Body, Headers>` and the handler return type.
- [x] 1.3 Update `HttpTrigger<Body, Headers>` interface to expose `method`, `request: { body, headers }`, `response: { body?, headers? }`, `inputSchema`, `outputSchema` as readonly own properties; remove the legacy flat `body` / `responseBody` / `headers` / `responseHeaders` properties.
- [x] 1.4 Reshape `HttpTriggerPayload<Body, Headers = Record<string, never>>` in `packages/core/src/index.ts:15` so handler types reflect declared headers; update SDK re-exports. Payload stays flat at runtime.
- [x] 1.5 Reshape `HttpTriggerResult<Headers = Record<string, string>>` in `packages/core/src/index.ts:9`.
- [x] 1.6 Migrate every `httpTrigger(...)` call in `packages/sdk/src/index.test.ts` to grouped form; update assertions for new property exposure.
- [x] 1.7 Confirm `packages/sdk/src/index.ts:745` re-export list still covers the new shape; no API additions to the export list itself.

## 2. Manifest composition (`packages/sdk/src/cli/build-workflows.ts`)

- [x] 2.1 Update `composeHttpInputSchema` (line 426) to consume `request.body` + `request.headers` JSON Schemas (with the empty-record default for headers) and embed both under `properties.body` / `properties.headers` in the composite payload.
- [x] 2.2 Update `composeHttpOutputSchema` (line 444) to consume the optional `response.body` and `response.headers` JSON Schemas; when `response.headers` present, replace the loose `headersJsonSchema()` with the author-supplied schema; when absent, keep the loose form.
- [x] 2.3 Update `buildTriggerEntry` for HTTP triggers to emit the manifest entry shape `{ name, type: "http", method, request: { body, headers }, response?: { body?, headers? }, inputSchema, outputSchema }`. Omit the `response` key entirely when neither `response.body` nor `response.headers` is declared.
- [x] 2.4 Update `ManifestSchema` (HTTP trigger discriminant) to require `request: { body, headers }`, accept optional `response: { body?, headers? }`, and reject HTTP entries with top-level `body`, `responseBody`, `headers`, or `responseHeaders` keys.
- [x] 2.5 Migrate every inline `httpTrigger(...)` fixture in `packages/sdk/src/cli/build-workflows.test.ts` (lines 89, 188, 198, 231, 560+) to grouped form; update manifest-shape assertions for the new entry layout.

## 3. Runtime HTTP source (`packages/runtime/src/triggers/http.ts`)

- [x] 3.1 Replace `headersToRecord` (line 60) body with `out[k.toLowerCase()] = v;` — explicit lowercasing per the spec's load-bearing-contract requirement.
- [x] 3.2 Rewrite `serializeHttpResult` (line 78) to fill `content-type` explicitly: `application/json; charset=UTF-8` for object body, `text/plain; charset=UTF-8` for string body, none for null/undefined/empty; case-insensitive author-wins check; replace the `c.json` call with `c.body(JSON.stringify(body), …)` so the contract no longer relies on Hono's side effect.
- [x] 3.3 Verify the existing 422 path in `validationFailure` (line 68) routes header-validation issues identically to body-validation issues — no code change expected, but confirm via test.
- [x] 3.4 Confirm `validatorTypes` / `buildFire` automatically pick up the new composite input schema (it's read off `descriptor.inputSchema`, no source-side change needed).
- [x] 3.5 **REVERT** `filterDeclaredHeaders` from `http.ts` once the `extras: "strip"` rehydrator (Group 10) lands. The host-side filter is replaced by zod-native `.strip()` mode; remove the helper and inline `headersToRecord` back into the rawInput construction.

## 10. Boolean `strip` meta marker + post-rehydration walker (D13)

The Group 10 design has been simplified twice: from `extras` enum (currently shipped) to boolean `strip`, and from a parallel-walk approach (Zod + JSON Schema together) to a Zod-tree-only walker that reads `.meta()` directly on each rehydrated node. The collapse is justified by two facts proven via probe:

1. Only the strip case is lossy in the zod ↔ JSON Schema round-trip — reject (`additionalProperties: false` → `.strict()`) and passthrough (`additionalProperties: {}` → `.loose()`) round-trip natively.
2. `.meta()` survives the FULL round-trip: `toJSONSchema` flattens custom keys to the JSON Schema root, `fromJSONSchema` rehydrates them, callable via `.meta()` on the resulting zod schema.

Tasks below replace the currently-shipped enum implementation. Delete obsolete code/tests.

### 10.x — Code rewrites

- [x] 10.1 SDK `httpTrigger` factory's `request.headers` handling becomes peek-and-maybe-attach (overridable):
  - Read author's `.meta()` (if any) and the schema's `_def.catchall.def.type` (catchall mode).
  - If `.meta()` already has a `strip` key (any value), no-op.
  - Else if catchall is `any` (author wrote `.loose()` / `.passthrough()`), no-op.
  - Else attach `.meta({ strip: true })`.
  - No throws, no `extras` enum value to validate.
- [x] 10.2 Drop the SDK CLI build-time error path for `.loose()` / `.passthrough()` on `request.headers`. Author choice wins.
- [x] 10.3 Author docstrings in `packages/sdk/src/index.ts` updated: document `.meta({ strip: true })` as the boolean marker; explain that reject/passthrough round-trip natively via `z.strictObject` / `.loose()`.
- [x] 10.4 `packages/runtime/src/workflow-registry.ts:rehydrateSchema` becomes:
  ```ts
  function rehydrateSchema(...) {
    const base = z.fromJSONSchema(schema);
    return applyStripMarkers(base);
  }
  ```
  where `applyStripMarkers` walks just the Zod tree (no JSON Schema parallel walk):
  - For each `ZodObject`: recurse into `shape` first.
  - Read `.meta()` on the node. If `strip === true`, rebuild as `z.object(shape)` (strip default).
  - Else if children changed but no strip marker, detect parent mode via `_def.catchall.def.type` (`"never"` → `z.strictObject`; `"any"` → `z.object().loose()`; otherwise `z.object()`) and rebuild to incorporate new children.
  - Preserve other meta keys via a final `.meta(meta)` chain when reconstructing.
- [x] 10.5 Inline the walker as a file-private helper in `workflow-registry.ts` (no separate file). Test helper `triggers/test-descriptors.ts` imports the rehydrator from `workflow-registry.ts`.
- [x] 10.6 Delete `packages/runtime/src/triggers/extras-modes.ts` and `extras-modes.test.ts`. Replace test coverage with new tests in `workflow-registry.test.ts` covering: strip preserved end-to-end; reject preserved natively (no marker); passthrough preserved natively (no marker); nested strip child inside strict envelope; preserve other meta keys when rebuilding.

### 10.x — Test fixture / spec updates

- [x] 10.7 Manifest emission tests in `build-workflows.test.ts` updated: declared `request.headers` produces JSON Schema with top-level key `strip: true` (was `extras: "strip"`). Default empty-record case same.
- [x] 10.8 Drop the SDK build-time error tests in `build-workflows.test.ts` for `.meta({ extras: "reject" })`, `.meta({ extras: "passthrough" })`. Drop the `.loose()` rejection test (now permissive). Add: SDK does NOT fail when author writes `.meta({ strip: false })` or `.loose()` on `request.headers` (manifest emission still succeeds; runtime gets the author's chosen mode).
- [x] 10.9 Migrate every test fixture using `extras: "strip"` to `strip: true`:
  - `packages/runtime/src/triggers/http.test.ts` — `declaredHeadersSchema` and the empty-record schema.
  - `packages/runtime/src/ui/trigger/middleware.test.ts` — envelope-shape tests.
  - Search-and-replace `extras: "strip"` → `strip: true` (string-replace; the marker is the only enum value remaining).
- [x] 10.10 Update SDK shape test in `packages/sdk/src/index.test.ts` to assert the JSON Schema contains `strip: true` (was `extras: "strip"`).

### 10.x — Validation gate

- [x] 10.11 `pnpm validate` clean (lint + check + test).
- [x] 10.12 Re-run dev probe: `POST /webhooks/local/demo/demo/echo` with `x-trace-id: abc` plus an undeclared `cookie` header — verify persisted `trigger.request` event payload's headers slot contains only `x-trace-id` (cookie stripped end-to-end via the new rehydrator).

## 4. Trigger UI middleware (`packages/runtime/src/ui/trigger`)

- [x] 4.1 Update `middleware.ts` (line 74 `Server-side payload synthesis` block) to accept either a bare body or a `{body, headers?}` envelope; default `headers` to `{}` when not provided; pass through to `buildFire` unchanged.
- [x] 4.2 Update `middleware.test.ts` to cover both submission shapes (bare body, envelope with declared headers) plus a 422 failure for missing required header.
- [x] 4.3 Update card-rendering server template (`page.ts:descriptorToCardData` + new `composeHttpFormSchema` helper) to emit a `{body, headers}` envelope schema when `request.headers` has declared properties; suppress (bare body schema) when empty.
- [x] 4.4 No client-side change needed — Jedison naturally produces `{body, headers}` form values when the schema is shaped as the envelope, and the middleware already accepts both shapes (4.1 + 4.2 coverage).

## 5. Tests for HTTP source headers behaviour (`packages/runtime/src/triggers/http.test.ts`)

- [x] 5.1 Migrate every inline `httpTrigger(...)` fixture in this file to grouped form (the three `passes the normalized composite input` blocks at lines 295/319/345 plus any others).
- [x] 5.2 Rewrite the three composite-shape assertions at lines 295/319/345 — keep the 4-key shape check, add headers-content assertions. (4-key shape kept; new headers-content coverage added in the new `request headers contract` describe block.)
- [x] 5.3 Add test: `request: { headers: z.object({ "x-trace-id": z.string() }) }` — request with the header → handler sees only `{"x-trace-id": "abc"}`.
- [x] 5.4 Add test: schema-declared, request missing required header → 422 + structured issues. (Trigger.request-not-emitted assertion deferred — covered structurally by the existing pipeline since 422 prevents executor invocation.)
- [x] 5.5 Add test: schema-declared, request with extra undeclared headers — handler sees only declared keys, request succeeds (200, not 422).
- [x] 5.6 Add test: empty-record headers schema declared → undeclared incoming keys are stripped before reaching the handler (covered by the "Ajv strips undeclared headers" test).
- [x] 5.7 Add test: incoming `X-Trace-Id` (uppercase) → handler sees `payload.headers["x-trace-id"]` (lowercased).
- [x] 5.8 Add test: `response: { headers: ... }` declared, handler returns matching shape → ok (added in build-fire.test.ts as the structural location for output validation).
- [x] 5.9 Add test: `response: { headers: ... }` declared, handler returns wrong shape → no-issues failure routed to 500 + structured-issues warning (added in build-fire.test.ts).
- [x] 5.10 Add test: `serializeHttpResult` content-type matrix — object body gets `application/json; charset=UTF-8`; string body gets `text/plain; charset=UTF-8`; null/undefined body gets no content-type; author-set `Content-Type` (uppercase) wins case-insensitively.
- [x] 5.11 `trigger.request` event payload audit covered by the dev-probe gate 9.8: end-to-end POST through `/trigger` envelope, persisted archive shows `headers: {"x-trace-id":"via-trigger-ui"}` only — no `cookie` / `user-agent` / `host` / etc. The strip-silently contract holds end-to-end through the rehydrator + persistence pipeline.

## 6. demo.ts canonical reference (`workflows/src/demo.ts`)

- [x] 6.1 Migrate every `httpTrigger(...)` in demo.ts to grouped form (config-restructure mechanical rename).
- [x] 6.2 Add typed `request.headers` schema to `greet` (POST httpTrigger): `z.object({ "x-trace-id": z.string().optional() })`; have the handler echo the trace id into the response body.
- [x] 6.3 Add typed `response.headers` schema to `greetJson`: `z.object({ "x-app-version": z.string() })`; have the handler return a fixed version string.
- [x] 6.4 Confirm `runDemo` orchestrator still works end-to-end against the new shapes (no surface drift).

## 7. Other test fixture migrations

- [x] 7.1 Audit `packages/runtime/src/triggers/build-fire.test.ts` and `packages/runtime/src/triggers/validator.test.ts` for `httpTrigger(...)` fixtures or hand-rolled HTTP descriptor shapes; migrate to grouped form.
- [x] 7.2 Audit `packages/runtime/src/integration.test.ts` and any `*.test.ts` referencing HTTP triggers; migrate to grouped form.
- [x] 7.3 Grep for any remaining flat-form usage (`responseBody:`, `body: z.` immediately at httpTrigger config level) outside intentional legacy-rejection tests; migrate.

## 8. Documentation

- [x] 8.1 Add `## Upgrade notes` entry in CLAUDE.md describing BOTH breaking changes: (a) config restructure (`body` → `request.body`, `responseBody` → `response.body`, plus new `request.headers` / `response.headers`); (b) breaking default for `payload.headers` (now `{}` when no schema declared). Include a migration recipe with before/after snippets and `wfe upload`.
- [x] 8.2 Update `SECURITY.md §4` to note that undeclared headers no longer reach the event store; tighten the existing "never log Authorization" invariant with the new fact.

## 9. Validation gate

- [x] 9.1 `pnpm validate` (lint + check + test, parallel)
- [x] 9.2 `pnpm dev --random-port --kill` boots; stdout contains `Dev ready on http://localhost:<port> (tenant=dev)`. Note: webhook URL shape is `/webhooks/<owner>/<repo>/<workflow>/<trigger>` — for demo.ts that's `/webhooks/local/demo/demo/<trigger>` (owner=local, repo=demo, workflow=demo).
- [x] 9.3 `POST /webhooks/local/demo/demo/echo` with body `{"name":"Stefan"}` and header `x-trace-id: abc` → 200; response body includes `"traceId":"abc"` (handler echoed the validated header); subsequent `/trigger`-routed run confirms persisted `trigger.request` event headers slot contains ONLY the declared keys (no `cookie` / `user-agent` / `host` / etc.).
- [x] 9.4 Same endpoint without `x-trace-id` header → still 200; response body includes `"traceId":null` (header was optional in the schema, omitted at runtime).
- [x] 9.5 Strict-validation smoke (substitute path — invalid body type instead of touching demo.ts): `POST` with `{"name":42}` → 422 with `{"error":"payload_validation_failed","issues":[{"path":["body","name"],"message":"Invalid input: expected string, received number"}]}`. Same Zod validation path that gates required headers; the missing-required-header 422 case is covered by `http.test.ts` (`missing required declared header returns 422`).
- [x] 9.6 `POST /webhooks/local/demo/demo/greetJson` with valid body → 200; response carries `x-app-version: 1.0.0` per the declared `response.headers` schema, validated host-side via the rehydrator.
- [x] 9.7 `GET /dashboard` (session cookie for `local`) → 200 (no regression).
- [x] 9.8 `GET /trigger/local/demo` → 200; the trigger UI page contains `x-trace-id` rendered into the `echo` card's form schema; `POST /trigger/local/demo/demo/echo` with `{"body":{"name":"Stefan"},"headers":{"x-trace-id":"via-trigger-ui"}}` envelope → 200; persisted `trigger.request` event headers slot equals `{"x-trace-id":"via-trigger-ui"}` (envelope path end-to-end works; `extras:"strip"` rehydrator drops cookie/auth/etc.).
- [x] 9.9 `pnpm test:wpt` — ran by the user out-of-band: `Tests 23100 passed | 0 failed | 24519 skipped (47619)`. No regressions in headers-related WPT subtests; sandbox-stdlib was not modified by this change.
