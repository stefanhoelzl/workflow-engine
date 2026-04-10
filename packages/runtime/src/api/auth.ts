import { constants } from "node:http2";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const HTTP_UNAUTHORIZED =
	constants.HTTP_STATUS_UNAUTHORIZED as ContentfulStatusCode;
const HTTP_FORBIDDEN = constants.HTTP_STATUS_FORBIDDEN as ContentfulStatusCode;

interface GitHubAuthOptions {
	githubUser: string;
	fetchFn?: typeof globalThis.fetch;
}

function githubAuthMiddleware(options: GitHubAuthOptions): MiddlewareHandler {
	const { githubUser } = options;
	const fetchFn = options.fetchFn ?? globalThis.fetch;

	return async (c, next) => {
		const authHeader = c.req.header("authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json(
				{ error: "Missing or invalid Authorization header" },
				HTTP_UNAUTHORIZED,
			);
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
				return c.json({ error: "Invalid token" }, HTTP_UNAUTHORIZED);
			}
			const body = (await response.json()) as { login: string };
			login = body.login;
		} catch {
			return c.json({ error: "Invalid token" }, HTTP_UNAUTHORIZED);
		}

		if (login !== githubUser) {
			return c.json({ error: "Forbidden" }, HTTP_FORBIDDEN);
		}

		await next();
	};
}

export { githubAuthMiddleware };
export type { GitHubAuthOptions };
