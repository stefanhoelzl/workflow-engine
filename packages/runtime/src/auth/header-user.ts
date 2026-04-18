import type { MiddlewareHandler } from "hono";
import type { UserContext } from "./user-context.js";

// MAINTENANCE: the Traefik `strip-auth-headers` middleware
// (`infrastructure/modules/app-instance/routes-chart/templates/routes.yaml`)
// clears these headers on every route where oauth2-proxy is NOT authoritative.
// When adding a new `X-Auth-Request-*` reader here, append the header name to
// that middleware's `customRequestHeaders` list so forged values cannot reach
// any handler.
function parseHeaderUser(
	name: string,
	mail: string,
	groupsHeader: string,
): UserContext {
	const groups = groupsHeader
		.split(",")
		.map((g) => g.trim())
		.filter((g) => g.length > 0);
	return {
		name,
		mail,
		orgs: groups.filter((g) => !g.includes(":")),
		teams: groups.filter((g) => g.includes(":")),
	};
}

function headerUserMiddleware(): MiddlewareHandler {
	return async (c, next) => {
		const headerUser = c.req.header("X-Auth-Request-User");
		if (headerUser) {
			const user = parseHeaderUser(
				headerUser,
				c.req.header("X-Auth-Request-Email") ?? "",
				c.req.header("X-Auth-Request-Groups") ?? "",
			);
			c.set("user", user);
		}
		await next();
	};
}

export { headerUserMiddleware };
