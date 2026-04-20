import type { MiddlewareHandler } from "hono";
import { fetchOrgs, fetchUser } from "./github-api.js";
import type { UserContext } from "./user-context.js";

interface BearerUserMiddlewareOptions {
	readonly fetchFn?: typeof globalThis.fetch;
}

async function fetchBearerUser(
	token: string,
	fetchFn: typeof globalThis.fetch,
): Promise<UserContext | undefined> {
	const [user, orgs] = await Promise.all([
		fetchUser({ accessToken: token, fetchFn }),
		fetchOrgs({ accessToken: token, fetchFn }),
	]);
	if (!user.ok) {
		return;
	}
	return {
		name: user.data.login,
		mail: user.data.email ?? "",
		orgs: orgs.ok ? orgs.data.map((o) => o.login) : [],
	};
}

function bearerUserMiddleware(
	options: BearerUserMiddlewareOptions = {},
): MiddlewareHandler {
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	return async (c, next) => {
		const auth = c.req.header("authorization");
		if (auth?.startsWith("Bearer ")) {
			const token = auth.slice("Bearer ".length);
			const user = await fetchBearerUser(token, fetchFn);
			if (user) {
				c.set("user", user);
			}
		}
		await next();
	};
}

export type { BearerUserMiddlewareOptions };
export { bearerUserMiddleware };
