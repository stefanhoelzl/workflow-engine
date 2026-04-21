## 1. Core package — manifest schema + payload type

- [x] 1.1 In `packages/core/src/index.ts`, narrow `HttpTriggerPayload<Body, Params, Query>` to `HttpTriggerPayload<Body>`; drop the `Params` and `Query` generics and the `params` + `query` fields.
- [x] 1.2 Update `httpTriggerManifestSchema` in `packages/core/src/index.ts`: drop `path`, `params`, `query` fields; add `.regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)` on the `name` field.
- [x] 1.3 Update `HttpTriggerManifest` type export to reflect the narrowed schema (inference follows the schema; verify with `pnpm check`).

## 2. SDK surface trim

- [x] 2.1 Delete `type ExtractParams<T extends string>`, `type ParamsSchemaFor<P extends string>`, and `function extractParamNames(path: string)` from `packages/sdk/src/index.ts`.
- [x] 2.2 Narrow the `HttpTrigger<Path, Body, Params, Query>` interface to `HttpTrigger<Body>`; drop `path`, `params`, `query` properties; retain `[HTTP_TRIGGER_BRAND]`, `method`, `body`, `inputSchema`, `outputSchema`; retain the callable signature with the narrowed `HttpTriggerPayload<z.infer<Body>>` argument.
- [x] 2.3 Narrow the `httpTrigger<const P, B, Q>(config)` factory to `httpTrigger<B>(config)`; config type becomes `{ method?: string; body?: B; handler: (payload: HttpTriggerPayload<z.infer<B>>) => Promise<HttpTriggerResult> }`; build error on any of `path`, `params`, `query` passed.
- [x] 2.4 Update the composite schema built inside the factory to `z.object({ body, headers, url, method: z.string().default(method) })`; drop `params` and `query` fields.
- [x] 2.5 Update `attachTriggerMetadata` metadata shape: drop `path`, `params`, `query` slots; retain `method`, `body`, `inputSchema`, `outputSchema`.
- [x] 2.6 Remove the `extractParamNames` re-export from `packages/sdk/src/index.ts`.

## 3. Vite plugin

- [x] 3.1 In `packages/sdk/src/plugin/index.ts` `buildTriggerEntry`: drop the `trigger.path` read, drop the `extractParamNames(trigger.path)` call, drop the `trigger.query` handling block, and delete the `isEmptyObjectSchema` helper (no other callers).
- [x] 3.2 Add export-name validation in `buildTriggerEntry`: check `exportName` against `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`; on failure, call `ctx.error(\`Workflow "\${workflowName}": trigger export name "\${exportName}" must match /^[A-Za-z_][A-Za-z0-9_]{0,62}$/\`)`.
- [x] 3.3 Remove any `extractParamNames` import from the plugin module.

## 4. Runtime descriptor + source

- [x] 4.1 In `packages/runtime/src/executor/types.ts`, drop `path`, `params`, `query` fields from `HttpTriggerDescriptor`; retain `kind`, `type`, `name`, `method`, `body`, `inputSchema`, `outputSchema`.
- [x] 4.2 In `packages/runtime/src/triggers/http.ts`, delete `PARAM_SEGMENT_RE`, `WILDCARD_SEGMENT_RE`, `toUrlPatternPath`, `extractParams`, `extractQueryParams`.
- [x] 4.3 Replace `SourceEntry` with a shape that omits `pattern` and `isStatic` (retain `tenant`, `workflow`, `bundleSource`, `descriptor`). Replace `SourceMatch` with a shape that omits `params` (retain `tenant`, `workflow`, `bundleSource`, `descriptor`).
- [x] 4.4 Replace `sourceLookup` and the `entries: readonly SourceEntry[]` state with a `Map<string, SourceEntry>` keyed by `${tenant}/${workflow}/${descriptor.name}`. The lookup path is `entries.get(key)`; method mismatch still returns `undefined` (→ 404 in middleware).
- [x] 4.5 Update the middleware handler: parse exactly three segments after `/webhooks/`; fewer or more → 404; validate each segment against its regex (tenant + workflow: existing `TENANT_NAME_RE`; trigger: new `TRIGGER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/`). Assemble `rawInput = { body, headers, url, method }`; drop `params` and `query` keys.
- [x] 4.6 Update `reconfigure(view)` to build the new Map; drop the `URLPattern` construction and the `isStatic` flag.
- [x] 4.7 Retain the empty-webhooks GET probe behavior (`HTTP_NO_CONTENT` when entries present, `HTTP_SERVICE_UNAVAILABLE` otherwise) unchanged.

## 5. UI trigger page + middleware

- [x] 5.1 In `packages/runtime/src/ui/trigger/page.ts`, replace `webhookUrl = \`/webhooks/${tenant}/${workflow}/${http.path}\`` with `\`/webhooks/${tenant}/${workflow}/${http.name}\``.
- [x] 5.2 Update the comment at `packages/runtime/src/ui/trigger/page.ts:17` and `packages/runtime/src/ui/trigger/middleware.ts:21` to drop `params/query` from the payload enumeration (new text: "headers/url/method from the real HTTP request").

## 6. Demo workflow + SECURITY.md + CLAUDE.md

- [x] 6.1 In `workflows/src/cronitor.ts`, drop the `path: "cronitor"` field from the `httpTrigger({...})` call. Note the resulting URL change to `/webhooks/<tenant>/cronitor/cronitorWebhook` (or rename the export to `cronitor` for URL preservation — operator's call).
- [x] 6.2 Update `SECURITY.md §3`: replace the URL-matching paragraph (lines 844-846) with the exact three-segment description; narrow the payload snippet (lines 850-852) to `{ body, headers, url, method }`; DELETE the W8 threat row (around line 870); DELETE the R-W6 residual-risk row (around line 916); REPLACE the "Deterministic path matching via URLPattern" mitigation bullet (around lines 895-896) with a positive "Closed URL vocabulary" mitigation paragraph describing the regex-constrained three-segment shape and the no-URL-derived-data guarantee.
- [x] 6.3 Prepend the `fix-http-trigger-url` upgrade note to the `## Upgrade notes` section of `CLAUDE.md` (top-most entry; follows the format of prior notes).

## 7. Tests — deletions

- [x] 7.1 In `packages/runtime/src/triggers/http.test.ts`, delete the static-vs-parameterized precedence test suite, the wildcard catch-all test, and all assertions on `payload.params` and `payload.query`.
- [x] 7.2 In `packages/sdk/src/plugin/workflow-build.test.ts`, delete the `TRIGGER_WITH_QUERY` and `WILDCARD_TRIGGER` fixtures and their associated assertions; update `BASIC_WORKFLOW` to drop `path:`.
- [x] 7.3 In `packages/sdk/src/index.test.ts`, delete `ExtractParams` type tests and update httpTrigger shape assertions (no `path`, no `params`, no `query` on the returned callable).
- [x] 7.4 In `packages/runtime/src/ui/trigger/middleware.test.ts`, update `makeEntry` to drop `path: "..."` and `params: []` fixture fields; update the URL assertion at line 150 to match the new shape (`/webhooks/t0/cronitor/<export-name>`).

## 8. Tests — additions

- [x] 8.1 In `packages/runtime/src/triggers/http.test.ts`, add a test "URL with four segments returns 404" (request `/webhooks/t/w/trigger/extra`).
- [x] 8.2 Add a test "URL with two segments returns 404" (request `/webhooks/t/w`).
- [x] 8.3 Add a test "URL segment failing trigger regex returns 404" (request `/webhooks/t/w/bad$name`).
- [x] 8.4 Add a test "method mismatch returns 404" (registered POST trigger, GET request).
- [x] 8.5 Add a test "query string is preserved in payload.url and no payload.query field" (request `/webhooks/t/w/x?foo=bar` with valid body; assert `payload.url` contains `?foo=bar` and `Object.keys(payload)` equals `["body","headers","url","method"]`).
- [x] 8.6 In `packages/sdk/src/plugin/workflow-build.test.ts`, add an `INVALID_TRIGGER_NAME` fixture (`export const $weird = httpTrigger({...})`) and assert the build fails with the identifier-regex error message.
- [x] 8.7 Add a fixture exercising a valid `_privateHook` export name (underscore-prefixed) and assert the build succeeds.

## 9. Security tests

- [x] 9.1 In `packages/runtime/src/triggers/http.test.ts`, add a test that confirms a request with `?params=injected` does not populate any structured field on the payload (defense against authors migrating from `payload.params` that might expect automatic behavior).
- [x] 9.2 Add a test confirming method-mismatch returns the same 404 response body as unknown-trigger (no information leak via response differentiation).

## 10. Validation

- [x] 10.1 `pnpm lint` passes (Biome).
- [x] 10.2 `pnpm check` passes (tsc; zero errors expected).
- [x] 10.3 `pnpm test` passes (all unit + integration tests).
- [x] 10.4 Inspected `workflows/dist/bundle.tar.gz` after `pnpm dev` built it: the `cronitor` workflow's HTTP trigger entry contains only `name`, `type: "http"`, `method: "POST"`, `body`, `inputSchema`, `outputSchema`; no `path`, `params`, or `query`. Composite `inputSchema` has exactly `{body, headers, url, method}` as required properties.
- [x] 10.5 Grep the tree for residual references to deleted surfaces: `descriptor\.path`, `payload\.params`, `payload\.query`, `URLPattern`, `toUrlPatternPath`, `extractParamNames`, `ExtractParams`, `ParamsSchemaFor`, `PARAM_SEGMENT_RE`, `WILDCARD_SEGMENT_RE`, `extractQueryParams`, `isEmptyObjectSchema` — confirm zero hits in `packages/` and `workflows/`.
- [x] 10.6 `pnpm exec openspec validate fix-http-trigger-url` reports no errors.

## 11. Manual smoke (local dev)

- [x] 11.1 `pnpm dev` boots the runtime, builds the workflows bundle, and registers the `dev` tenant via `POST /api/workflows/dev` → `204`. (Fixed a pre-existing dev-script env-var bug in `scripts/dev.ts`: `GITHUB_USER` → `AUTH_ALLOW` so open-auth mode actually applies.)
- [x] 11.2 Happy path: `POST /webhooks/dev/cronitor/cronitorWebhook` with the cronitor fixture body → `202`.
- [x] 11.3 Extra URL segment: `POST /webhooks/dev/cronitor/cronitorWebhook/extra` → `404`.
- [x] 11.4 Method mismatch: `GET /webhooks/dev/cronitor/cronitorWebhook` → `404`.
- [x] 11.5 Unknown trigger name: `POST /webhooks/dev/cronitor/unknownOne` → `404`.
- [x] 11.6 Bad-regex trigger segment: `POST /webhooks/dev/cronitor/bad$name` → `404`.
- [x] 11.7 Query string tolerated: `POST /webhooks/dev/cronitor/cronitorWebhook?delivery=abc&foo=bar` with valid body → `202`.
- [x] 11.8 Body schema validation: `POST /webhooks/dev/cronitor/cronitorWebhook` with `{}` → `422`.
- [x] 11.9 Two URL segments: `POST /webhooks/dev/cronitor` → `404`.
