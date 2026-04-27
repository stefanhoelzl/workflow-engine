## Context

`httpTrigger` today (see `packages/sdk/src/index.ts:341` and `openspec/specs/http-trigger/spec.md`) accepts only a flat `{ method, body, responseBody, handler }` config. The composite payload `{ body, headers, url, method }` is built host-side in `packages/runtime/src/triggers/http.ts:headersToRecord` + middleware, validated against the manifest's composite JSON Schema (composed by `packages/sdk/src/cli/build-workflows.ts:composeHttpInputSchema`), and dispatched. Three motivations shape this change:

1. **Authors who need typed headers hand-roll validation in the handler.** A signature-verification flow (`x-hub-signature-256` etc.) reads the header inside the sandbox; if the request arrives malformed, we still pay sandbox cold-start before the handler decides to 401. The host-side Ajv gate already exists for `body` — adding headers to it costs one extra schema slot, no new infrastructure.
2. **`trigger.request` events persist every incoming header.** That includes `cookie`, `authorization`, and per-vendor signature secrets — soft tension with the §4 "never log Authorization" invariant. The `redact: ["req.headers", "res.headers"]` setting in `logger.ts:96` redacts the *pino logs*, not the event store, which is a separate persistence path.
3. **The flat `body` / `responseBody` naming is asymmetric**, and adding `headers` / `responseHeaders` to that pattern multiplies the asymmetry. The cheapest moment to restructure to symmetric `request: { body, headers }` / `response: { body, headers }` is now, before any production tenant workflows depend on the flat shape.

The branch name `http-infos` suggests scope creep risk — query params, structured URL parsing. The interview narrowed scope to: typed request/response headers, grouped `request`/`response` config restructure, plus two adjacent cleanups (lowercase contract, content-type contract). Query params are explicitly out of scope and remain parsed via `new URL(payload.url).searchParams`.

## Goals / Non-Goals

**Goals:**

- Authors can declare `request.headers: z.ZodType` on `httpTrigger`. Validated headers reach the handler as `payload.headers`. Validation failures return 422 host-side, before sandbox boot.
- Authors can declare `response.headers: z.ZodType`. Handler return-type's `headers` becomes `z.infer<R>`; validation runs at the host-side `validateOutput` boundary.
- `httpTrigger` config restructures to grouped `request: { body, headers }` / `response: { body, headers }`, with `method` staying top-level as the route discriminant.
- `trigger.request` records only validated headers — undeclared auth/cookie material never persists.
- Header-name lowercasing in `headersToRecord` and `content-type` filling in `serializeHttpResult` become explicit contracts in code, not implicit Hono/undici behaviours.
- `/trigger` dispatch UI renders header inputs from the manifest schema, same pipeline as `body`.
- `workflows/src/demo.ts` exercises the new surface (typed `request.headers` on `greet`, typed `response.headers` on `greetJson`) and demonstrates the grouped form.

**Non-Goals:**

- Typed query params. `payload.url` stays the only access path; authors continue to call `new URL(payload.url).searchParams`. The validator's `params` / `query` slots in `validator.test.ts:65` are a contrived test fixture, not production code, and remain untouched.
- Author-defined webhook paths or path parameters. `/webhooks/<owner>/<repo>/<workflow>/<trigger-name>` is unchanged.
- Header validation inside the sandbox. All validation is host-side.
- Restructuring the **runtime payload** to grouped form. The handler still receives flat `{ body, headers, url, method }`. The grouped form is config-only.
- Moving `method` into `request`. It stays top-level — it's the route discriminant for `/webhooks/*` matching, and existing executor/recovery code already treats it as trigger metadata distinct from request shape.
- A deprecation window for the breaking changes. Single-cycle break, documented under `## Upgrade notes`.

## Decisions

### D1. Config shape: grouped `request` / `response`, `method` stays top-level

```ts
function httpTrigger<
    ReqB extends z.ZodType = z.ZodAny,
    ReqH extends z.ZodType = z.ZodObject<Record<string, never>>,
    ResB extends z.ZodType | undefined = undefined,
    ResH extends z.ZodType | undefined = undefined,
>(config: {
    method?: string;
    request?: { body?: ReqB; headers?: ReqH };
    response?: { body?: ResB; headers?: ResH };
    handler: (payload: HttpTriggerPayload<z.infer<ReqB>, z.infer<ReqH>>) => Promise<…>;
}): HttpTrigger<…>;
```

**Why grouped over flat.** Symmetric, clearer at a glance, mirrors the Fetch API's `Request` / `Response` mental model. The pre-existing `body` / `responseBody` flat naming was already asymmetric; adding `headers` / `responseHeaders` to that pattern compounds the wart. With no production tenant workflows yet (only demo.ts + test fixtures call `httpTrigger`), the migration cost is bounded and one-time.

**Why `method` stays top-level.** It's the route discriminant for `/webhooks/<owner>/<repo>/<workflow>/<trigger-name>` matching — the HTTP TriggerSource looks at `descriptor.method` to reject method-mismatched requests with 404. Semantically it's about routing more than request shape. Moving it to `request.method` would also drag the cron / manual / imap descriptor types (which already store `method` in flat form for the http-discriminant union) into a touch they don't need.

**Alternatives considered:**

- Flat surface with `headers` / `responseHeaders`. Rejected — perpetuates the asymmetry; even the user described it as "not very clear."
- Fully grouped including `request.method`. Rejected — `method` is route metadata, not request-shape data; the executor / manifest already key off it as flat.
- Defer the restructure to a separate change. Rejected — bundling avoids two breaking changes for the same set of call sites.

### D2. Default for `request.headers` when omitted: empty object `{}`

When the author does not declare a request headers schema, `payload.headers = {}`. **Breaking change** — today undeclared = full `Record<string, string>`.

**Why.** Symmetric "opt-in to expose data" model. Aligns with the §4 invariant about not logging auth-bearing headers: if an author never declares them, the runtime never has to make a decision about whether to surface or persist them. Cuts the attack surface for accidental header-based information leakage to zero on triggers where the author doesn't care about headers.

**Alternatives considered:**

- Keep `Record<string, string>` as default. Non-breaking on this axis, but defeats the security gain — undeclared triggers still persist auth headers in the event store.
- Default to `z.record(z.string(), z.string())` (validate as map of strings, expose all). Doesn't strip undeclared keys, so still persists auth material. Same downside.

### D3. Default for `response.headers` when omitted: loose `Record<string, string>`

When the author does not declare a response headers schema, the handler may return any `headers: Record<string, string>` (today's behaviour). No breaking change on the response side.

**Why.** Asymmetric defaults are intentional: incoming headers are attacker-controlled (strict opt-in), outgoing headers are author-controlled (lenient default). Tightening the response default would force authors to declare schemas just to set `x-trace-id` on their responses, with no security upside.

### D4. Unknown request keys when schema is declared: stripped silently

Undeclared keys in the incoming `Record<string, string>` are dropped from the handler payload (and therefore from the persisted `trigger.request` event). Ambient UA headers (`user-agent`, `accept-encoding`, `cookie`, …) never reach the handler unless declared. Mechanism is described in D13 — the SDK marks the headers slot with `.meta({ extras: "strip" })` and the runtime rehydrator restores `.strip()` mode.

**Why.** Strict-mode rejection would 422 essentially every real request because every UA sends headers the author can't know about. Strip-silently is the only viable choice; we just have to recover it from the lossy zod-↔-JSON-Schema round-trip.

### D5. Lowercase normalization is an explicit contract

`headersToRecord` becomes:

```ts
function headersToRecord(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
}
```

**Why.** Today the lowercasing is implicit — the WHATWG Fetch spec mandates `Headers#forEach` yields lowercase, and undici implements it. With `request.headers` becoming a load-bearing schema slot that authors write zod against, the contract is no longer "incidental property of the HTTP layer" but "documented author-visible behaviour." Explicit `.toLowerCase()` makes that contract grep-able from the code rather than from a spec reference, and it survives any future swap of the HTTP layer.

Cost: one string allocation per header per request. Header counts are single-digit; allocation cost is below noise.

### D6. Validation site: host-side zod from the rehydrated manifest schema (both request and response)

Request and response validation share the same path: the `WorkflowRegistry` rehydrates each manifest JSON Schema once at registration time via `z.fromJSONSchema(...)`, attaches the resulting `zodInputSchema` / `zodOutputSchema` to the descriptor, and the trigger pipeline runs `descriptor.zodInputSchema.safeParse(input)` / `descriptor.zodOutputSchema.safeParse(output)` on every fire. No Ajv, no per-request compile, no sandbox-side validation.

Request failure → 422 with structured zod issues, no sandbox boot, no `trigger.request` event. Response failure → 500 + `trigger.error` (existing `validateOutput` path in `buildFire`).

**Why.** Reuses the post-rebase Zod-only pipeline. The only feature-specific concern is that zod v4's `toJSONSchema → fromJSONSchema` round-trip turns the author's default `.strip()` into runtime `.strict()` — for the headers slot, that's hostile (every real request 422s on `user-agent`). The fix lives in D13 (`extras` meta marker), not in the validation site itself.

**Alternatives considered:**

- Validate in the sandbox via zod. Rejected — sandbox cold-start on every malformed request is a DoS amplifier.
- Belt-and-suspenders (host + sandbox). Rejected — doubles validation cost on the happy path with no marginal safety win.

### D7. `trigger.request` records validated headers only

The widener that produces `trigger.request` events takes the *post-validation* payload. Since the headers slot rehydrates to `.strip()` mode (per D13), undeclared keys never make it into the validated payload, so the event payload's `headers` already equals what the handler saw. No additional filtering code path needed.

**Why.** Auth/cookie material in undeclared headers never gets persisted to the event store. Tightens the §4 invariant about not logging `Authorization` from "logger redaction" to "never reaches the persistence layer in the first place."

### D8. Response `content-type` filling is explicit, not Hono-derivative

`serializeHttpResult` becomes:

```ts
const headers: Record<string, string> = { ...(result.headers ?? {}) };
const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === "content-type");
if (typeof body === "string") {
    if (!hasContentType) headers["content-type"] = "text/plain; charset=UTF-8";
    return c.body(body, status, headers);
}
if (body === null || body === undefined) {
    return c.body("", status, headers);
}
if (!hasContentType) headers["content-type"] = "application/json; charset=UTF-8";
return c.body(JSON.stringify(body), status, headers);
```

**Why.** Today's JSON content-type comes from Hono's `c.json` side-effect, not our code. With `response.headers` becoming a typed contract authors validate against, the runtime's content-type behaviour needs to be a documented contract too. Explicit filling makes it grep-able and swap-resilient. `text/plain` for strings is the conventional fallback (RFC 7231) and gives a small XSS-defence-in-depth win — a string body without `content-type` could be MIME-sniffed as HTML by a browser; pinning `text/plain` blocks that.

Author always wins: case-insensitive `content-type` check, runtime only fills when absent.

### D9. Manifest format restructures to grouped HTTP trigger entries

```jsonc
// before
{
  "name": "webhook",
  "type": "http",
  "method": "POST",
  "body": { /* JSON Schema */ },
  "responseBody": { /* JSON Schema, optional */ },
  "inputSchema": { /* composite */ },
  "outputSchema": { /* composite */ }
}

// after
{
  "name": "webhook",
  "type": "http",
  "method": "POST",
  "request":  { "body": { /* JSON Schema */ }, "headers": { /* JSON Schema */ } },
  "response": { "body": { /* JSON Schema */ }, "headers": { /* JSON Schema */ } }, // both inner fields optional, "response" itself optional
  "inputSchema": { /* composite */ },
  "outputSchema": { /* composite */ }
}
```

`request.body` and `request.headers` are required (defaults applied at build time when the author omits them: `body` → `z.any()` → JSON Schema `{}`; `headers` → empty zod object → JSON Schema `{ type: "object", properties: {}, additionalProperties: false }`). `response` is optional; when present, `body` and `headers` inside it are individually optional.

**Why.** Mirrors the SDK config shape, keeps the manifest authoritative, lets `composeHttpInputSchema` / `composeHttpOutputSchema` consume the grouped form directly without a flat-to-grouped translation step. `inputSchema` and `outputSchema` (the composite forms used by Ajv at runtime) remain alongside the structured `request`/`response` entries — they are the de-normalized form derived from the structured fields, kept in the manifest because the runtime's Ajv compile cache keys on them.

**Alternatives considered:**

- Keep flat `body` / `responseBody` in the manifest, only restructure the SDK config. Rejected — leaves the manifest mid-translation and forces `composeHttpInputSchema` to undo its own grouping.
- Drop `inputSchema` / `outputSchema` and reconstruct on every load. Rejected — adds host-side compile cost and complicates the existing Ajv-WeakMap caching.

### D10. Dispatch UI (`/trigger`) renders header inputs from manifest schema

The `/trigger` form already renders body inputs from the manifest's `inputSchema.properties.body`. With `inputSchema.properties.headers` now author-supplied, the same form pipeline picks it up automatically — no UI-side conditional needed beyond rendering the existing `headers` slot when its schema has properties.

**Server-side payload synthesis** (`packages/runtime/src/ui/trigger/middleware.ts:74`) currently constructs `{ body: <posted JSON>, headers: {}, url, method }` and validates. With this change, the form posts either a bare body (today's shape, backwards-compatible for cards with no header inputs) or a `{body, headers}` envelope; the synthesizer handles both shapes.

### D11. demo.ts migration

Every `httpTrigger` in `workflows/src/demo.ts` migrates to grouped form. `greet` (POST) declares `request.headers: z.object({ "x-trace-id": z.string().optional() })` and reads it. `greetJson` declares `response.headers: z.object({ "x-app-version": z.string() })` and returns it. No HMAC example — the existing `crypto.subtle` usage in demo.ts already covers signing, and an HMAC verify flow would bloat the file.

### D13. Boolean `meta({ strip: true })` marker + post-rehydration walker restores `.strip()` mode through the manifest round-trip

**The round-trip flaw (only strip is lossy).** Zod v4's default `.object()` mode is strip-silently. `z.toJSONSchema(z.object({...}))` emits `additionalProperties: false`, which `z.fromJSONSchema(...)` rehydrates as `.strict()` (reject extras). JSON Schema has no native way to encode strip-silently — only true/false/missing for `additionalProperties`, none of which means "drop without error". So author intent (strip) is lost across the manifest boundary.

The other two modes round-trip *natively*:

- `z.strictObject({...})` → `additionalProperties: false` → `.strict()`. ✅
- `z.object({...}).loose()` → `additionalProperties: {}` → `.loose()`. ✅

Only the strip case collides with strict. So a single boolean marker is sufficient — `reject` and `passthrough` don't need our help.

**The marker.** Authors annotate any zod object schema:

```ts
z.object({...}).meta({ strip: true })   // force .strip() mode at runtime
```

`.meta()` survives the FULL round-trip (proven by probe): not only does `toJSONSchema` flatten `.meta()` keys into the top-level JSON Schema, `fromJSONSchema` reads them back so the rehydrated zod schema's `.meta()` returns the same object the author originally attached. Custom keys (`strip`, `title`, `foo`, …) all preserved.

This means the rehydrator doesn't need to walk the JSON Schema in parallel — it can read `.meta()` directly on each rehydrated zod node.

**SDK auto-wrap (overridable).** The `httpTrigger` factory's request.headers handling is "peek-and-maybe-attach":

1. If the author already attached `.meta({ strip: ... })` (any value), respect it — no-op.
2. Else if the schema's catchall is `.loose()` / `.passthrough()` (i.e. author wrote `.loose()`), respect it — no-op.
3. Else (default `z.object({...})` case): attach `.meta({ strip: true })` so the strip intent survives the round-trip.

The auto-wrap captures the implicit "I wrote `z.object({...})` and expect strip locally" footgun, but stays out of the way for authors who explicitly chose another mode. No build-time errors — the SDK is permissive; the author decides.

**Detecting catchall mode for preservation when only children change.** When a nested child has `strip: true` and the rehydrator must rebuild the parent to incorporate the modified child, parent's mode is preserved by inspecting `_def.catchall`:

- `_def.catchall.def.type === "never"` → strict — rebuild as `z.strictObject(shape)`.
- `_def.catchall.def.type === "any"` → loose — rebuild as `z.object(shape).loose()`.
- catchall null/absent → strip default — rebuild as `z.object(shape)`.

**Custom rehydrator (no parallel walk).** `WorkflowRegistry`'s `rehydrateSchema` calls `z.fromJSONSchema(...)` and walks just the rehydrated zod tree:

```ts
function rehydrate(schema: Record<string, unknown>): z.ZodType {
  const base = z.fromJSONSchema(schema);
  return applyStripMarkers(base);
}

function applyStripMarkers(zod: z.ZodType): z.ZodType {
  if (!(zod instanceof z.ZodObject)) return zod;

  const oldShape = zod.shape;
  const newShape: Record<string, z.ZodType> = {};
  let childrenChanged = false;
  for (const [k, v] of Object.entries(oldShape)) {
    const rebuilt = applyStripMarkers(v);
    if (rebuilt !== v) childrenChanged = true;
    newShape[k] = rebuilt;
  }

  const meta = zod.meta?.() ?? {};
  const stripMarked = meta.strip === true;
  if (!stripMarked && !childrenChanged) return zod;

  // Detect parent catchall to preserve mode if only children changed.
  const catchallType = (zod as { _def?: { catchall?: { _def?: { type?: string } } } })
    ._def?.catchall?._def?.type;
  let rebuilt: z.ZodType;
  if (stripMarked) {
    rebuilt = z.object(newShape);                  // strip default
  } else if (catchallType === "never") {
    rebuilt = z.strictObject(newShape);            // preserve strict
  } else if (catchallType === "any") {
    rebuilt = z.object(newShape).loose();          // preserve passthrough
  } else {
    rebuilt = z.object(newShape);                  // already strip
  }
  if (Object.keys(meta).length > 0) rebuilt = rebuilt.meta(meta);
  return rebuilt;
}
```

**Why.** This is the smallest mechanism that recovers author-intent strip-silently across the JSON Schema round-trip while keeping all other validation behaviour (strict on body, strict on action output, etc.) unchanged. Single-purpose helper, ~25 LOC, file-private to `workflow-registry.ts` (the only production caller). Future use cases that need strip on a different slot just attach `.meta({ strip: true })` and inherit the rehydrator behaviour for free.

**Alternatives considered (and rejected):**

- **Host-side filter (`filterDeclaredHeaders` in `http.ts`).** Implemented and shipped initially. ~25 LOC, HTTP-source-local. Rejected once we found `.meta()` round-trips end-to-end: the meta-driven path keeps author intent visible in the manifest, generalises beyond headers, and survives any future swap of the validation layer.
- **`extras` enum (`strip | reject | passthrough`).** Implemented and shipped after the host-side filter. Rejected after recognising that reject and passthrough round-trip natively via zod's standard JSON Schema serialization — the enum's other two values added zero capability, just API surface.
- **Parallel-walk approach** (walk both the rehydrated Zod and the source JSON Schema, reading `extras` from JSON Schema). Implemented and shipped under the enum design. Rejected once we verified `.meta()` is callable on the rehydrated zod node directly — the parallel walk was unnecessary plumbing.
- **Lean on author writing `.passthrough()` for a usable surface.** Rejected — `.passthrough()` keeps every undeclared key in the validated payload, defeating the §4 invariant about not persisting `Authorization`/`Cookie` *by default*. The strip auto-wrap recovers the security-positive default while still allowing explicit author override.
- **Vendor-extension keyword (`x-zod-strip: true`) outside `.meta()`.** Rejected — `.meta()` is zod's native, documented escape hatch for arbitrary metadata; a parallel keyword would duplicate machinery the SDK and runtime already exercise.

### D12. Test rewrite at `http.test.ts:295/319/345`

The three composite-shape assertions stay (still verify the 4-key shape) but gain headers-content coverage in the same `it` blocks. Add new tests:

- "headers schema declared → only declared keys reach handler"
- "headers schema omitted → empty object reaches handler"
- "response.headers schema declared, handler returns wrong shape → 500 + trigger.error"
- "response.headers schema omitted → handler-returned headers pass through unchecked"

Fills the existing coverage gap where no test pinned the headers slot's *contents*.

## Risks / Trade-offs

- **Two breaking changes in one cycle.** Config restructure (`body` → `request.body`, `responseBody` → `response.body`) AND headers default flip. → Mitigation: small blast radius (demo.ts + test fixtures, no production tenants), documented under a single `## Upgrade notes` entry; the migration is a mechanical find-replace.
- **Manifest format break.** Old manifests written by the previous SDK no longer validate against the new `ManifestSchema`. → Mitigation: tenants rebuild + `wfe upload` after pulling the new SDK. No backwards-compat shim — bundling the rebuild with the headers default flip means tenants only do the upgrade dance once.
- **Lowercase contract may surprise authors used to header names like `X-Trace`.** A zod schema with `"X-Trace"` as key never matches incoming `"x-trace"`. → Mitigation: documented in the spec scenario; demo.ts uses lowercase keys; ergonomic guidance in CLAUDE.md `## Upgrade notes`.
- **Stripping undeclared headers loses forensic data.** A signed-webhook trigger that declares `x-hub-signature-256` will not record `user-agent` in the event store, making attribution harder for support investigations. → Mitigation: accepted trade-off — the §4 invariant about not logging auth-bearing material is load-bearing; forensic UA logging can be added later as a separate decision if there's demand.
- **`content-type` for string bodies changes from "absent" to `text/plain; charset=UTF-8`.** A handler that returned a JSON string and relied on no content-type to defer typing to a downstream consumer will see a different wire shape. → Mitigation: author-set content-type always wins (case-insensitive); authors who want the prior behaviour can set `content-type: ""` or any explicit value. Probably zero real tenant impact.
- **`response.headers` validation runs on the success path.** Adds one zod `safeParse` call per request when declared. → Mitigation: descriptor's `zodOutputSchema` is rehydrated once at registration time and reused; per-request cost is a single zod parse pass.
- **Custom rehydrator complexity (D13).** The post-rehydration walker adds ~25 LOC to `workflow-registry.ts` and depends on `_def.catchall.def.type` to detect a `ZodObject`'s mode (strict / loose / strip) — a zod-internal field. → Mitigation: cover with unit tests pinning round-trip preservation; if zod renames the internal field across versions, the dependency surfaces in one place and is easy to update.
- **Author opt-out for `request.headers` strip is by writing `.meta({ strip: false })` or `.loose()`.** The SDK auto-wraps strip by default; author can override. An author who legitimately wants every incoming header (auditing, forwarding to a downstream allowlisted service) writes the override and accepts the security implication (cookies / auth headers reach the handler and event store). → Mitigation: the override is explicit and visible in the workflow source, so reviewers can flag it; documented in the SDK docstrings + upgrade-notes.
- **Asymmetry between config (grouped) and runtime payload (flat).** Authors write `request: { body, headers }` in config but read `payload.body` / `payload.headers` in the handler. → Mitigation: documented; the alternative (grouped runtime payload too) is a deeper change with no usability win — handlers would type more (`payload.request.body`) for no semantic gain.

## Migration Plan

1. Land D1-D12 in a single PR: SDK signature, manifest format, runtime contracts, tests, demo.ts.
2. Add `## Upgrade notes` entry to CLAUDE.md describing BOTH breaking changes (config restructure + headers default). Tenants rebuild and `wfe upload` once.
3. No state wipe required for events/persistence — the format break is in *manifests*, not events; old events keep their shape and the runtime keeps reading them.
4. No backwards-compat shim — single-cycle break, justified by the small known blast radius.
5. SECURITY.md §4 gets an updated reference: the "never log Authorization" invariant now also notes that undeclared headers never persist to the event store.

## Open Questions

- **Content-type fallback for `Buffer`/`ArrayBuffer` response bodies.** Today `serializeHttpResult` handles only string/object/null. If an author returns a `Uint8Array` from the handler (already possible via the bridge), the type is `unknown` and falls into the JSON branch — `JSON.stringify(Uint8Array)` is `"{...}"` which is wrong. This is a pre-existing bug, not introduced by this change, but `text/plain` and `application/json` defaults amplify it. → Defer; file as a separate issue if it lands.
- **`trigger-ui` rendering ergonomics for header inputs.** A POST trigger form with both body and headers fields could get visually crowded. → Defer; punt on UX polish to follow-up if the form gets noisy in practice. The functional contract (form renders header inputs from manifest schema) is the spec; visual polish is implementation.
