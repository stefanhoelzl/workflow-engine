import { constants } from "node:http2";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const HTTP_UNAUTHORIZED =
	constants.HTTP_STATUS_UNAUTHORIZED as ContentfulStatusCode;

function unauthorized(c: Context) {
	return c.json({ error: "Unauthorized" }, HTTP_UNAUTHORIZED);
}

function rejectAllMiddleware(): MiddlewareHandler {
	return async (c) => unauthorized(c);
}

interface GitHubAuthOptions {
	githubUsers: string[];
	fetchFn?: typeof globalThis.fetch;
}

function githubAuthMiddleware(options: GitHubAuthOptions): MiddlewareHandler {
	const { githubUsers } = options;
	const fetchFn = options.fetchFn ?? globalThis.fetch;

	return async (c, next) => {
		const authHeader = c.req.header("authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return unauthorized(c);
		}

		const token = authHeader.slice("Bearer ".length);
		let login: string;
		try {
			const response = await fetchFn("https://api.github.com/user", {
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
				},
			});
			if (!response.ok) {
				return unauthorized(c);
			}
			const body = (await response.json()) as { login: string };
			login = body.login;
		} catch {
			return unauthorized(c);
		}

		if (!githubUsers.includes(login)) {
			return unauthorized(c);
		}

		await next();
	};
}

export type { GitHubAuthOptions };
export { githubAuthMiddleware, rejectAllMiddleware };
