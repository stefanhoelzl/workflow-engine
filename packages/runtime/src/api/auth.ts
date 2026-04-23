import { constants } from "node:http2";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ProviderRegistry } from "../auth/providers/index.js";

const HTTP_UNAUTHORIZED =
	constants.HTTP_STATUS_UNAUTHORIZED as ContentfulStatusCode;

const PROVIDER_HEADER = "x-auth-provider";

function unauthorized(c: Context) {
	return c.json({ error: "Unauthorized" }, HTTP_UNAUTHORIZED);
}

interface ApiAuthOptions {
	readonly registry: ProviderRegistry;
}

// `/api/*` provider dispatcher (SECURITY.md §4). Reads X-Auth-Provider, looks
// up the registered provider, and asks it to resolve identity from the raw
// request. Every failure mode returns an identical 401 to prevent enumeration.
function apiAuthMiddleware(options: ApiAuthOptions): MiddlewareHandler {
	return async (c, next) => {
		const id = c.req.header(PROVIDER_HEADER);
		if (!id) {
			return unauthorized(c);
		}
		const provider = options.registry.byId(id);
		if (!provider) {
			return unauthorized(c);
		}
		const user = await provider.resolveApiIdentity(c.req.raw);
		if (!user) {
			return unauthorized(c);
		}
		c.set("user", user);
		await next();
	};
}

export type { ApiAuthOptions };
export { apiAuthMiddleware, PROVIDER_HEADER };
