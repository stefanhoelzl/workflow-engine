import type { MiddlewareHandler } from "hono";
import { isMember, validateOwner } from "./owner.js";

// Enforces SECURITY.md §4 for any route with a `:owner` path parameter:
// validate identifier format, then require the caller to be a member of the
// owner. Every failure mode responds with `c.notFound()` so the sub-app's
// notFoundHandler controls the body shape.
function requireOwnerMember(): MiddlewareHandler {
	return async (c, next) => {
		const owner = c.req.param("owner") ?? "";
		if (!validateOwner(owner)) {
			return c.notFound();
		}
		const user = c.get("user");
		if (user && isMember(user, owner)) {
			await next();
			return;
		}
		return c.notFound();
	};
}

export { requireOwnerMember };
