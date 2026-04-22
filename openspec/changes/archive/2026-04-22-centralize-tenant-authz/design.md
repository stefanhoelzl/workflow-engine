## Context

The SECURITY.md §4 invariant for tenant-scoped routes — *validate `:tenant` against the identifier regex AND `isMember(user, tenant)`, fail-closed 404 on both paths* — has two inline implementations today:

- `packages/runtime/src/api/upload.ts:59-68` — private `checkTenantAccess(c, tenant)`. Bypass on `c.get("authOpen") === true`. On failure: `c.json({error:"Not Found"}, 404)`.
- `packages/runtime/src/ui/trigger/middleware.ts:102-107` — inline in the POST handler. Bypass on `user` being falsy (`if (user && !tenantSet(user).has(tenant))`). On failure: `c.notFound()` (plain text).

Semantic divergence: the trigger path bypasses whenever `user` is absent for *any* reason; the upload path only bypasses when `authOpen` is explicitly set by `sessionMiddleware` / `apiMiddleware`. Both achieve the open-mode-dev goal today, but the trigger pattern also silently bypasses if authn fails to populate `user` due to a bug, which could mask a regression.

The `auth` capability already specs `isMember(user, tenant)` and the `authOpen` flag (L151-180, L211 of `openspec/specs/auth/spec.md`). It does not spec *where* the check runs; the duplication is under-specified rather than contradictory.

## Goals / Non-Goals

**Goals:**
- Single canonical enforcement point for tenant authorization.
- Identical open-mode semantics for every `:tenant` route (the `authOpen` pattern wins).
- Uniform JSON 404 body across `/api` and `/trigger` sub-apps.
- Spec captures the enforcement mechanism so future `:tenant` routes are obliged to mount the middleware.

**Non-Goals:**
- Rewriting the stale `trigger-ui` spec (tracked separately).
- Adding authentication to `/webhooks/*` (public per §3, unchanged).
- Changing the `isMember` predicate, the `authOpen` flag, or any allow-list behaviour.
- Extending the middleware to non-tenant authorization concerns.

## Decisions

**D1. Hono middleware, not a helper function.**
Mount `requireTenantMember()` via `app.use(...)` at the subpath. Rationale: per-route middleware fails closed for *future* routes added under the same subpath — a new `/trigger/:tenant/<anything>` route inherits the check for free. A helper that each handler must remember to call fails open on forgotten invocations. Alternative considered: exported `checkTenantAccess(c, tenant)` helper. Rejected — relies on handler discipline, doesn't fix the "next route will drift" root cause.

**D2. No configuration; hardcoded `:tenant` param name.**
Both call sites today use the path param named `tenant`. A configurable `paramName` or `resolve(c)` accessor adds a knob with no current consumer. If a future route names it differently, that route can rename its param — there is no legitimate reason for a tenant-scoped route to call it something else. Keeps the spec requirement terse.

**D3. Mount per-subpath, not per-route.**
- `/api`: `app.use("/workflows/:tenant", requireTenantMember())` (and `/workflows/:tenant/*` if subroutes arrive later — for now the only route is the exact path, so the single-segment mount is sufficient).
- `/trigger` sub-app: `app.use("/:tenant/*", requireTenantMember())` relative to the `/trigger` basePath. The GET `/` and `""` render routes don't have a `:tenant` segment and are unaffected.
Alternative considered: per-route `app.post("/:tenant/:workflow/:trigger", requireTenantMember(), handler)`. Rejected — more verbose and misses future routes (D1).

**D4. JSON 404 body, delegated via `app.notFound()`.**
Middleware calls `c.notFound()` — content-type-agnostic. Each sub-app registers its own `app.notFound(c => c.json({error:"Not Found"}, 404))` handler so the body shape is chosen by the app, not baked into the middleware. Observable consequence: `POST /trigger/:tenant/:workflow/:trigger` 404 body changes from plain-text `"404 Not Found"` to JSON `{"error":"Not Found"}`. No known client reads the body; the UI form submits from authenticated sessions where 404 is not expected.

**D5. `authOpen`-flag bypass, not user-absence bypass.**
The middleware bypasses `isMember` iff `c.get("authOpen") === true`. This is explicit and set only by `sessionMiddleware` (for UI routes in open mode) and by `apiMiddleware` (for `/api` in open mode). Aligns with the existing `auth` spec L211 normative text: *"a request-scoped `authOpen` flag SHALL be set so tenant-scoped handlers bypass membership checks consistent with today's open-mode behaviour."* The trigger handler's current `if (user && …)` pattern is quietly upgraded to the stricter `authOpen` pattern, closing the "missing user masks authn bug" gap.

**D6. Always validate tenant format, even in open mode.**
Order inside the middleware: `validateTenant` first (path-safety / anti-enumeration), then `authOpen`, then `isMember`. Open-mode is a dev convenience for the *membership* check; it does not relax the identifier regex, which is a defence-in-depth against path-traversal / storage-key injection.

## Risks / Trade-offs

- **Trigger POST 404 body shape becomes JSON** → Mitigation: call out as a minor breaking observable in the proposal; any test asserting plain-text 404 gets updated in the same change. No external consumer depends on the body.
- **Spec pins middleware as implementation** → Adds an implementation detail to the `auth` spec. Trade-off accepted: the invariant needs a named enforcement point to audit against, and the duplication problem is what motivated the proposal. If we ever want a different mechanism (e.g., route decorators), we update the spec at that time.
- **`auth/spec.md` grows by one requirement** — No risk; accretes naturally with existing `isMember` and `authOpen` requirements.
- **SECURITY.md §4 update could drift from the spec** → Mitigation: same-change update; §4 references `requireTenantMember` by name so a future audit catches divergence.
