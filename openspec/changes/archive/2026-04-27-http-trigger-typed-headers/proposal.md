## Why

Today `httpTrigger` only lets authors declare a zod schema for `body`. Headers reach the handler as an unfiltered `Record<string, string>` and response headers are free-form. That has two costs: (1) authors who need typed/validated incoming headers (HMAC-signed webhooks, version-gated APIs, content-type gates) hand-roll validation in the handler, paying sandbox cold-start on every malformed request; (2) `trigger.request` events persist *every* incoming header, so authentication-bearing names like `cookie`, `authorization`, and signature secrets land in the event store — a soft contradiction with the §4 invariant that forbids logging `Authorization`.

Layered on top: the existing `body` / `responseBody` config naming is asymmetric (no prefix on the request side, `response*` prefix on the response side). Adding `headers` / `responseHeaders` to that pattern multiplies the asymmetry. Since the only existing `httpTrigger` call sites are demo.ts and test fixtures (no production tenant workflows yet), this is the cheapest moment to restructure into a symmetric `request: { body, headers }` / `response: { body, headers }` grouping that mirrors the Fetch API mental model.

This change therefore adds typed request/response headers AND restructures the `httpTrigger` config surface in a single cycle.

## What Changes

- **`httpTrigger` config restructure (BREAKING)**: replace the flat `{ method, body, responseBody, handler }` shape with `{ method, request: { body?, headers? }, response: { body?, headers? }, handler }`. `method` stays at the top level — it is the route discriminant for `/webhooks/*` matching, not request-shape metadata.
- **`request.headers?: z.ZodType`** — typed request headers. Default when omitted: a Zod object schema with no declared properties (empty record). Handler payload type's `headers` becomes `z.infer<H>` when declared, `Record<string, never>` (`{}`) when omitted.
- **`response.headers?: z.ZodType`** — typed response headers. Default when omitted: loose `Record<string, string>` (today's behaviour). Handler return type's `headers?` becomes `z.infer<R>` when declared.
- **`request.body?: z.ZodType`** and **`response.body?: z.ZodType`** — same semantics as today's flat `body` and `responseBody`, just relocated. `request.body` defaults to `z.any()`. `response.body` is absent when omitted (loose envelope).
- **BREAKING**: when `request.headers` is omitted, `payload.headers` is the empty object `{}` (was: full `Record<string, string>` of all incoming headers). Tenants who read headers without declaring a schema must add `request.headers: z.object({...})` and re-`wfe upload`.
- **Handler payload stays flat at runtime**: `{ body, headers, url, method }`. The grouped form is a *config* concept only — handlers continue to read `payload.body` / `payload.headers` directly, not `payload.request.body`.
- **Header normalization**: `headersToRecord` becomes explicit about lowercasing (`k.toLowerCase()`) rather than relying on undici's `Headers#forEach` semantics. Authors write zod schemas with lowercase keys.
- **Validation pipeline**:
  - Request: composite input JSON Schema in the manifest now includes the author-supplied `request.headers` schema (default `{type: "object", properties: {}, additionalProperties: false, strip: true}` — the `strip: true` top-level key is zod's `.meta({ strip: true })` flattened into the JSON Schema by `toJSONSchema`). Host-side zod runs as today; failures return 422 with structured zod issues, no sandbox boot, no `trigger.request` event.
  - Response: composite output JSON Schema gains an optional `headers` slot when `response.headers` is declared. Validation runs at the host-side `validateOutput` boundary, on mismatch surfaces as 500 + `trigger.error` (existing path).
- **Unknown header keys** (when a request schema is declared) are stripped silently. Mechanism: the SDK auto-attaches `.meta({ strip: true })` to the `request.headers` zod schema by default; the runtime workflow-registry rehydrator reads `.meta()` directly off the rehydrated zod schema (zod v4's `.meta()` survives the full `toJSONSchema → fromJSONSchema` round-trip) and, where `strip === true`, reconstructs the corresponding `ZodObject` in default `.strip()` mode. Without the marker the round-trip would produce `.strict()` because `additionalProperties: false` is the only encoding zod v4 emits for both strip-default and strict modes — `.strict()` would 422 every real request because of ambient `user-agent`, `accept-encoding`, `cookie`, etc. Authors MAY write `.meta({ strip: true })` on any object schema in their workflow to opt into strip-after-round-trip on non-headers slots; the SDK's auto-wrap on `request.headers` is overridable (an author who writes `.meta({ strip: false })` or `.loose()` / `.passthrough()` keeps their explicit choice). Reject and passthrough modes do not need a marker — they round-trip natively via zod's standard JSON Schema serialization (`additionalProperties: false` → `.strict()`; `additionalProperties: {}` → `.loose()`).
- **Event store**: `trigger.request` records the *validated* headers (post-Ajv strip), not the raw set. Auth/cookie material in undeclared headers never gets persisted.
- **Wire response (`serializeHttpResult`)** becomes explicit about content-type filling, dropping reliance on Hono's `c.json` side-effect:
  - Object body, no author `content-type` → fill `application/json; charset=UTF-8`.
  - String body, no author `content-type` → fill `text/plain; charset=UTF-8`.
  - Empty/null body → no auto-fill.
  - Author-set `content-type` always wins; check is case-insensitive.
- **Manifest format (BREAKING)**: HTTP trigger entries restructure from `{ method, body, responseBody?, inputSchema, outputSchema }` to `{ method, request: { body, headers }, response?: { body?, headers? }, inputSchema, outputSchema }`. `request.body` and `request.headers` are required JSON Schemas (defaults applied at build time when the author omits the zod schema); `response` is optional, and its `body` / `headers` slots are individually optional.
- **Dispatch UI (`/trigger`)** renders header inputs from the manifest schema using the existing body-rendering pipeline.
- **`workflows/src/demo.ts`** migrates every `httpTrigger` to the grouped form, adds a typed `request.headers` declaration on `greet` (POST) and a typed `response.headers` declaration on `greetJson`, per the canonical-reference rule in CLAUDE.md.
- **Test coverage**: rewrite `packages/runtime/src/triggers/http.test.ts:295/319/345` to cover headers content under both schema-declared and schema-omitted modes, filling the existing gap where no test pinned the headers slot's contents.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `http-trigger`: `httpTrigger` factory restructures to grouped `request` / `response` config; gains typed request and response headers; handler payload shape changes (declared `headers` only, default `{}`); response-shaping pipeline pins explicit `content-type` defaults. (SDK-surface details live in this spec, not in `sdk/spec.md`.)
- `workflow-manifest`: HTTP trigger entry shape restructures to `{ method, request: { body, headers }, response?: { body?, headers? }, … }`; `ManifestSchema` enforces the new shape.
- `payload-validation`: trigger ingress validation now also gates request headers; trigger output validation also gates response headers when declared.
- `trigger-ui`: trigger form renders header inputs from the manifest schema for HTTP triggers; server-side payload synthesizer accepts a `{body, headers}` envelope.

## Impact

**Code**:

- `packages/sdk/src/index.ts` — `httpTrigger` signature (grouped `request`/`response`), `attachTriggerMetadata`, `HttpTrigger` interface, exported `HttpTriggerPayload<Body, Headers>` generic.
- `packages/sdk/src/cli/build-workflows.ts` — `composeHttpInputSchema` / `composeHttpOutputSchema` consume the grouped config; manifest entry construction emits `request: {...}` / `response?: {...}`.
- `packages/core/src/index.ts` — `HttpTriggerPayload<Body, Headers = Record<string, never>>`, `HttpTriggerResult<Headers = Record<string, string>>`.
- `packages/runtime/src/triggers/http.ts` — `headersToRecord` (explicit `.toLowerCase()`), `serializeHttpResult` (explicit content-type fill, case-insensitive author-wins).
- `packages/runtime/src/ui/trigger/middleware.ts` — server-side payload synthesis must accept the `{body, headers}` envelope and respect declared headers when synthesizing test requests via `/trigger`.
- `workflows/src/demo.ts` — every `httpTrigger` migrated to grouped form; typed `request.headers` and `response.headers` examples.

**Tests** (every existing httpTrigger fixture migrates to grouped form):

- `packages/runtime/src/triggers/http.test.ts` — rewrite three composite-shape assertions; add headers-content coverage; migrate fixtures.
- `packages/sdk/src/index.test.ts` — `httpTrigger` shape tests for grouped form + new defaults.
- `packages/sdk/src/cli/build-workflows.test.ts` — every inline `httpTrigger(...)` test fixture migrates; manifest output shape under declared / omitted header schemas.
- `packages/runtime/src/triggers/build-fire.test.ts`, `packages/runtime/src/triggers/validator.test.ts`, integration tests touching HTTP triggers.

**Docs**:

- `CLAUDE.md` `## Upgrade notes` entry documenting BOTH breaking changes (config restructure + headers default).
- `openspec/specs/{http-trigger,workflow-manifest,payload-validation,trigger-ui}/spec.md` deltas.

**Security**: tightens the §4 invariant about not logging `Authorization` — undeclared auth/cookie material no longer reaches the event store *by default*. The default is overridable: authors who write `.meta({ strip: false })` or `.loose()` / `.passthrough()` on `request.headers` opt back into the previous behaviour (cookies / auth headers reach the handler and event store) and accept those consequences explicitly. Threat model is otherwise unchanged: `/webhooks/*` remains public ingress (§3); the new validation gate runs in the same host-side zod path that already gates `body`, so no new sandbox-boundary surface.

**Migration**: two breaking changes, bundled in one cycle. Every existing `httpTrigger` call site (demo.ts, test fixtures) migrates to grouped form; manifest format changes simultaneously. No backwards-compat shim — single-cycle break, justified by the small blast radius (no production tenant workflows in flight).
