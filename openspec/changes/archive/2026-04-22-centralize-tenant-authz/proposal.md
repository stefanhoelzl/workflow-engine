## Why

Tenant-authorization for `:tenant`-scoped routes is duplicated across handlers — `api/upload.ts` (via a private `checkTenantAccess`) and `ui/trigger/middleware.ts` (inline) — with subtly divergent open-mode semantics (`authOpen` flag vs. `user`-absence-implies-bypass) and inconsistent 404 bodies (JSON vs. plain text). The SECURITY.md §4 invariant ("validate `:tenant` against the regex AND `isMember(user, tenant)`, fail-closed 404 on both paths") has two implementations; one will drift from the other on the next new route. This change collapses the check into a single Hono middleware, giving the invariant one canonical enforcement point to audit against.

## What Changes

- New `requireTenantMember()` middleware factory in `packages/runtime/src/auth/`. Behaviour: reads `:tenant` path param; 404 if `!validateTenant(tenant)`; pass-through if `c.get("authOpen")`; pass-through if `user && isMember(user, tenant)`; 404 otherwise.
- Mount `requireTenantMember()` per-subpath:
  - `/api/workflows/:tenant` in `api/index.ts`
  - `/trigger/:tenant/*` (relative to `/trigger` basePath) in `ui/trigger/middleware.ts`
- Remove inline tenant checks from `api/upload.ts` (`checkTenantAccess` + its call site) and `ui/trigger/middleware.ts` (the `validateTenant` + `tenantSet(user).has(tenant)` block in the POST handler).
- Register a JSON `notFound()` handler on both sub-apps (`c.json({error:"Not Found"}, 404)`), so 404 bodies are uniform.
- **BREAKING (minor)**: `POST /trigger/:tenant/:workflow/:trigger` 404 response body changes from plain-text `"404 Not Found"` to JSON `{"error":"Not Found"}`. Status code and semantics unchanged. No known client consumes the body (the UI submits from authenticated sessions).
- SECURITY.md §4 gets one new mitigation entry naming the middleware as the sole enforcement point; inline tenant checks in route handlers become prohibited.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `auth`: adds a new requirement "Tenant-authorization middleware" specifying `requireTenantMember()` and the routes that MUST mount it. The existing `isMember` and `authOpen` requirements are unchanged.

## Impact

- **Code**: `packages/runtime/src/auth/tenant-mw.ts` (new ~40 lines + tests); `packages/runtime/src/auth/tenant-mw.test.ts` (new); `packages/runtime/src/api/index.ts` (mount); `packages/runtime/src/api/upload.ts` (delete `checkTenantAccess` + call site); `packages/runtime/src/ui/trigger/middleware.ts` (mount, delete inline check).
- **Tests**: existing `api/upload.test.ts` and `ui/trigger/middleware.test.ts` assertions on 404 behaviour may need updates where they check body shape.
- **Docs**: SECURITY.md §4 gains a mitigation row; no other doc impact.
- **No impact on**: manifest format, SDK surface, sandbox boundary, EventBus pipeline, storage layout, tenant state, bundle shape. No tenant re-upload, no state wipe.
