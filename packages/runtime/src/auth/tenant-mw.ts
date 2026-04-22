import type { MiddlewareHandler } from "hono";
import { isMember, validateTenant } from "./tenant.js";

// Enforces SECURITY.md §4 for any route with a `:tenant` path parameter:
// validate identifier format, then (unless `authOpen` is set) require the
// caller to be a member of the tenant. Every failure mode responds with
// `c.notFound()` so the sub-app's notFoundHandler controls the body shape.
function requireTenantMember(): MiddlewareHandler {
	return async (c, next) => {
		const tenant = c.req.param("tenant") ?? "";
		if (!validateTenant(tenant)) {
			return c.notFound();
		}
		if (c.get("authOpen")) {
			await next();
			return;
		}
		const user = c.get("user");
		if (user && isMember(user, tenant)) {
			await next();
			return;
		}
		return c.notFound();
	};
}

export { requireTenantMember };
