## Why

Today's HTTP trigger router admits a silent-conflict class: two `httpTrigger({path:"hook", ...})` exports in the same workflow compile, upload, and resolve non-deterministically at request time (registration-order wins, no warning). The `path:` argument's expressive features (`:param` named segments, `*wildcard` catch-all) exist for a REST-shaped integration model that webhooks don't actually need — webhook URLs are opaque identifiers copy-pasted once into a provider's config UI. Making the URL mechanical — derived from the trigger's export name — collapses the collision surface to zero (JS export-name uniqueness makes it impossible by construction) and brings HTTP triggers into alignment with the `cron-trigger` capability, whose URLs are already mechanical.

## What Changes

- **BREAKING — SDK surface**: `httpTrigger({ method?, body?, handler })`. The `path`, `params`, and `query` config fields are removed; passing them is a build error. The type `HttpTrigger<Path, Body, Params, Query>` becomes `HttpTrigger<Body>`. `ExtractParams<T>`, `ParamsSchemaFor<P>`, and `extractParamNames` are deleted from the SDK.
- **BREAKING — handler payload**: `HttpTriggerPayload<Body>` = `{ body, headers, url, method }`. The `params` and `query` fields are gone; reading them fails to typecheck. Handlers that need a query-string value parse `new URL(payload.url).searchParams` explicitly.
- **BREAKING — webhook URL shape**: the URL is mechanically `/webhooks/<tenant>/<workflow>/<export-name>` where `<export-name>` is the trigger's exported identifier. There is no other routing mechanism. Query strings on the URL are tolerated (they pass through in `payload.url` opaquely) but not parsed.
- **BREAKING — manifest schema**: HTTP trigger entries drop `path`, `params`, and `query`. Remaining required fields: `name`, `type:"http"`, `method`, `body`, `inputSchema`, `outputSchema`. The `name` field is regex-constrained to `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` (URL-safe; length-capped to mirror the tenant regex). Existing tenant tarballs are rejected at upload validation; tenants must re-upload.
- **BREAKING — runtime routing**: `HttpTriggerDescriptor` drops `path`, `params`, `query`. The HTTP `TriggerSource` replaces URLPattern compilation with a `Map<string, SourceEntry>` keyed by `${tenant}/${workflow}/${name}`. The middleware parses exactly three URL segments after `/webhooks/`; any other shape returns 404. Method mismatch returns 404 (identical to "no matching trigger" to prevent enumeration).
- **NEW — build-time export-name validation**: the vite-plugin rejects HTTP trigger exports whose identifier does not match `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`, with a clear error message.
- **Removed code (~230 lines net)**: `URLPattern` compilation path, `PARAM_SEGMENT_RE`/`WILDCARD_SEGMENT_RE`, `toUrlPatternPath()`, `extractParams()`, `extractQueryParams()`, static-vs-parameterized two-pass lookup, the `:param`/`*wildcard` SDK type-inference machinery, and the `isEmptyObjectSchema` plugin helper.
- **SECURITY.md §3 updates in the same change**: the W8 threat row (URL-parameter injection) and the R-W6 residual-risk row (params unsanitized) are deleted — no URL-derived structured data reaches the handler. The "URLPattern routing" mitigation bullet is replaced with a positive "Closed URL vocabulary" mitigation describing the three-segment regex-constrained shape. The payload snippet narrows to `{ body, headers, url, method }`. No new NEVER rule in CLAUDE.md — existing invariants cover the surface.
- **Trigger UI**: `descriptor.name` replaces `descriptor.path` in the webhook-URL string construction. No user-visible form changes — the UI was already body-only (never rendered a `query` form). Two stale comments at `packages/runtime/src/ui/trigger/page.ts:17` and `middleware.ts:21` are refreshed to drop `params/query` from the payload description.
- **Demo workflow (`workflows/src/cronitor.ts`)**: drop `path: "cronitor"`. The URL becomes `/webhooks/<tenant>/cronitor/cronitorWebhook`. Either the cronitor.io webhook target is updated to the new URL or the export is renamed to `cronitor` for URL preservation.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `http-trigger`: factory drops `path`, `params`, `query`; payload narrows to `{body, headers, url, method}`; URL-to-trigger routing becomes exact three-segment match on `(tenant, workflow, trigger-name)` via constant-time Map lookup; `Trigger registry routing rules` requirement is REMOVED; two requirements are ADDED ("Trigger URL is derived from export name" and "URL carries no structured data"); `Public ingress security context` requires a corresponding SECURITY.md §3 update (W8 + R-W6 deleted; new "Closed URL vocabulary" mitigation).
- `workflow-manifest`: HTTP trigger entries drop `path`, `params`, `query`; `name` field regex-constrained to `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`; parameterized-path and wildcard-path scenarios REMOVED.
- `vite-plugin`: `buildTriggerEntry` drops `path`/`params` emission; a new build-time requirement validates HTTP trigger export identifiers against the URL-safe regex.

## Impact

- **Code**: `packages/core/src/index.ts` (manifest schema + payload type); `packages/sdk/src/index.ts` (factory, interface, conditional types); `packages/sdk/src/plugin/index.ts` (manifest emission + export-name validation); `packages/runtime/src/executor/types.ts` (descriptor); `packages/runtime/src/triggers/http.ts` (middleware + reconfigure + lookup); `packages/runtime/src/ui/trigger/page.ts` (webhook URL construction + stale comment); `packages/runtime/src/ui/trigger/middleware.ts` (stale comment).
- **Tests**: deletions in `packages/runtime/src/triggers/http.test.ts` (routing-precedence + wildcard + query suites) and `packages/sdk/src/plugin/workflow-build.test.ts` (fixtures with `path:`, `:param`, `*wildcard`, query). New tests: "extra URL segments → 404", "missing URL segments → 404", "method mismatch → 404", "query string passes through unparsed", "non-URL-safe export name fails build". `packages/runtime/src/ui/trigger/middleware.test.ts` + `packages/sdk/src/index.test.ts` fixture cleanup.
- **On-disk/storage**: tenant `workflows/<tenant>.tar.gz` must be re-uploaded after redeploy (manifest schema narrows). `pending/` and `archive/` prefixes unchanged; no wipe required. The DuckDB event index rebuilds from `archive/` on boot without modification.
- **Public API**: `/webhooks/<tenant>/<workflow>/<trigger-name>` shape is now the only valid route. Tenants whose former `path:` differed from the export name see URL changes. The kind-agnostic `/trigger/<tenant>/<workflow>/<trigger-name>` endpoint used by the trigger UI is unaffected.
- **Documentation**: `SECURITY.md §3` (threats table, residual risks table, mitigations, payload snippet); `CLAUDE.md` (new `fix-http-trigger-url` upgrade note at the top of the `## Upgrade notes` section); `workflows/src/cronitor.ts` (demo).
- **Dependencies**: none added, none removed. The sandbox `URLPattern` polyfill (at `packages/sandbox/src/polyfills/entry.ts`) remains — it exists for guest code, not for our router, and is unaffected.
