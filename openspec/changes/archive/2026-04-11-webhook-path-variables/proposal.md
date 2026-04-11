## Why

HTTP trigger paths are currently static strings matched by exact equality. Real-world webhooks often carry resource identifiers in the URL itself (e.g., `/webhooks/users/abc123/status`). Without path variables, workflow authors must use a single catch-all path and manually parse the URL string inside action handlers, losing type safety and validation.

## What Changes

- The `http()` helper accepts `:param` and `*wildcard` segments in the `path` string (e.g., `"users/:userId/status"`, `"files/*rest"`)
- Path parameter names are inferred from the path string at the TypeScript level via template literal types, giving typed `payload.params` in action handlers with zero redundancy
- An optional `params` Zod schema can be provided for runtime validation/coercion beyond the default `string` type, with compile-time enforcement that its keys match the path's param names
- Every HTTP trigger payload gains a `params` field (`Record<string, string>`) — always present, empty `{}` for static paths
- `HttpTriggerRegistry` replaces exact string matching with `URLPattern`-based matching, preferring static paths over parameterized ones when both could match
- Param names are extracted from the path at build time and stored in the manifest for runtime validation
- `ManifestSchema` gains an optional `params` array on trigger entries

## Capabilities

### New Capabilities

(None — all changes extend existing capabilities)

### Modified Capabilities

- `triggers`: Path variables support — `:param` named segments, `*wildcard` catch-all, URLPattern-based matching with static-over-parameterized priority, typed `payload.params` via template literal inference, optional params Zod schema with compile-time key enforcement, build-time param name extraction
- `workflow-manifest`: Trigger entries gain a `params` array of extracted param names; `ManifestSchema` updated accordingly

## Impact

- **SDK** (`packages/sdk/src/index.ts`): New template literal types for param extraction, updated `HttpTriggerInput`, `HttpPayloadSchema`, and `http()` function. `ManifestSchema` trigger entries gain optional `params` field.
- **Runtime** (`packages/runtime/src/triggers/http.ts`): `HttpTriggerRegistry` rewritten to use `URLPattern` with static-first priority. `httpTriggerMiddleware` merges extracted params into payload.
- **Manifest format**: Trigger entries gain `params: string[]` (extracted at build time by vite plugin).
- **Existing workflows**: Backward compatible — static paths work unchanged, payload gains `params: {}`.
- **Node.js**: `URLPattern` requires Node 22+ (project uses Node 24).
- **No new dependencies**: `URLPattern` is a built-in web standard.
