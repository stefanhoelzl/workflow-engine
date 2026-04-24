import type { MiddlewareHandler } from "hono";
import { isMember, validateOwner, validateRepo } from "./owner.js";

// Enforces SECURITY.md §4 for any route with a `:owner` (and optional `:repo`)
// path parameter: validate identifier format, then require the caller to be a
// member of the owner. When a `:repo` param is present on the matched route,
// its regex is also validated here so that every protected entry point
// fails-closed on malformed inputs. Every failure mode responds with
// `c.notFound()` so the sub-app's notFoundHandler controls the body shape.
function requireOwnerMember(): MiddlewareHandler {
	return async (c, next) => {
		const owner = c.req.param("owner") ?? "";
		if (!validateOwner(owner)) {
			return c.notFound();
		}
		const repo = c.req.param("repo");
		if (repo !== undefined && !validateRepo(repo)) {
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
