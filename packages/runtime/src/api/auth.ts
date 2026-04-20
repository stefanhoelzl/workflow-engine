import { constants } from "node:http2";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type Auth, allow } from "../auth/allowlist.js";
import type { UserContext } from "../auth/user-context.js";

const HTTP_UNAUTHORIZED =
	constants.HTTP_STATUS_UNAUTHORIZED as ContentfulStatusCode;

function unauthorized(c: Context) {
	return c.json({ error: "Unauthorized" }, HTTP_UNAUTHORIZED);
}

function rejectAllMiddleware(): MiddlewareHandler {
	return async (c) => unauthorized(c);
}

interface AuthorizeOptions {
	readonly auth: Extract<Auth, { mode: "restricted" }>;
}

// Gate for `/api/*`. Assumes `bearerUserMiddleware` ran first and populated
// `UserContext` on success. Rejects with an identical 401 for every failure
// path (missing token, invalid token, GitHub error, allow-list miss) to
// prevent enumeration.
function authorizeMiddleware(options: AuthorizeOptions): MiddlewareHandler {
	const { auth } = options;
	return async (c, next) => {
		const user = c.get("user") as UserContext | undefined;
		if (!user) {
			return unauthorized(c);
		}
		if (!allow(user, auth)) {
			return unauthorized(c);
		}
		await next();
	};
}

export type { AuthorizeOptions };
export { authorizeMiddleware, rejectAllMiddleware };
