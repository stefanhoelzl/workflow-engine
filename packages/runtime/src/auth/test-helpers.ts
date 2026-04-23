import { Hono } from "hono";
import type { UserContext } from "./user-context.js";

// Test helper for handler/middleware tests that need an authenticated baseline
// without exercising the full provider machinery. Wraps an app in a stub
// middleware that pre-populates `c.set("user", user)`. Production code MUST
// NOT depend on this — it only lives so per-handler tests don't have to mint
// session cookies or stub provider factories.
function withTestUser(app: Hono, user: UserContext): Hono {
	const wrapped = new Hono();
	wrapped.use("*", async (c, next) => {
		c.set("user", user);
		await next();
	});
	wrapped.route("/", app);
	return wrapped;
}

export { withTestUser };
