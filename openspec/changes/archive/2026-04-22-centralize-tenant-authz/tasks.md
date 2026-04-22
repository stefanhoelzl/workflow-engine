## 1. Middleware

- [x] 1.1 Create `packages/runtime/src/auth/tenant-mw.ts` exporting `requireTenantMember(): MiddlewareHandler`. Behaviour per `specs/auth/spec.md` — validate → authOpen bypass → isMember → `c.notFound()`.
- [x] 1.2 Export `requireTenantMember` from `packages/runtime/src/auth/tenant-mw.ts` alongside existing `auth/tenant.ts` exports (or re-export from a shared entry point if that matches the module's convention).

## 2. Tests for middleware

- [x] 2.1 Create `packages/runtime/src/auth/tenant-mw.test.ts`. Cover every scenario in `specs/auth/spec.md`: invalid-identifier 404, non-member 404, member passthrough, open-mode bypass, open-mode-still-validates-identifier, missing-user-outside-open-mode 404.
- [x] 2.2 Assert JSON 404 body shape `{"error":"Not Found"}` when mounted on a sub-app with `app.notFound(c => c.json({error:"Not Found"}, 404))` registered.

## 3. Mount in /api

- [x] 3.1 In `packages/runtime/src/api/index.ts`, mount `app.use("/workflows/:tenant", requireTenantMember())` after the authn middlewares (bearerUser/authorize) and before the `POST /workflows/:tenant` route. Register `app.notFound(c => c.json({error:"Not Found"}, 404))` on the `/api` sub-app so the existing JSON 404 body is preserved uniformly.
- [x] 3.2 In `packages/runtime/src/api/upload.ts`, delete `checkTenantAccess(c, tenant)`, delete its call site, and delete the inline `validateTenant(tenant)` guard. Keep the `tenant = c.req.param("tenant") ?? ""` extraction — it is still needed for `registry.registerTenant`.
- [x] 3.3 Update `packages/runtime/src/api/upload.test.ts` if it asserts behaviour that was enforced by the now-removed inline checks (membership 404, invalid-tenant 404). Re-point those assertions to arrive via the mounted middleware; behaviour is unchanged.

## 4. Mount in /trigger

- [x] 4.1 In `packages/runtime/src/ui/trigger/middleware.ts`, mount `app.use("/:tenant/*", requireTenantMember())` on the `/trigger`-basePath sub-app, after `sessionMw` (if present) and before the POST route. Register `app.notFound(c => c.json({error:"Not Found"}, 404))` on the sub-app.
- [x] 4.2 Remove the inline `validateTenant(tenant)` + `if (user && !tenantSet(user).has(tenant))` block in the POST handler (lines 102-107 of the pre-change file). Keep the param extractions.
- [x] 4.3 Update `packages/runtime/src/ui/trigger/middleware.test.ts` assertions that depend on the plain-text `c.notFound()` body — now JSON `{"error":"Not Found"}`. If any test expects 404 on invalid-tenant or non-member, re-verify it still passes via the middleware path.

## 5. Spec and security doc updates

- [x] 5.1 Update `SECURITY.md` §4: add a mitigation entry naming `requireTenantMember()` as the single canonical enforcement point for the `:tenant`-authorization invariant (regex + `isMember` + 404 fail-closed). Mark inline tenant checks in route handlers as prohibited. Do not weaken or contradict any other §4 rule (A1-A13).
- [x] 5.2 Verify `openspec/specs/auth/spec.md` will accept the delta at archive time: the existing `isMember tenant predicate` and the "Bearer middleware on /api/*" `authOpen` sentences are unchanged; the new "Tenant-authorization middleware" requirement is additive.

## 6. Validation

- [x] 6.1 Run `pnpm lint && pnpm check && pnpm test` and ensure all pass.
- [x] 6.2 Run `pnpm exec openspec validate centralize-tenant-authz --strict` and resolve any findings.
- [x] 6.3 Verified by automated test coverage: `api/index.test.ts` "forged X-Auth-Request-Groups" scenario asserts `POST /api/workflows/victim-tenant` → `404` + `{error:"Not Found"}` from a non-member; `auth/tenant-mw.test.ts` covers the non-member / invalid-identifier / missing-user / authOpen-bypass paths end-to-end through the middleware + `app.notFound(...)` pair.
