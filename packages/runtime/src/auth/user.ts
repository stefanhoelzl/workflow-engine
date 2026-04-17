import type { MiddlewareHandler } from "hono";

interface UserContext {
	readonly name: string;
	readonly mail: string;
	readonly orgs: readonly string[];
	readonly teams: readonly string[];
}

interface UserMiddlewareOptions {
	readonly fetchFn?: typeof globalThis.fetch;
}

interface GitHubUserPayload {
	login: string;
	email: string | null;
}

interface GitHubOrgPayload {
	login: string;
}

interface GitHubTeamPayload {
	slug: string;
	organization: { login: string };
}

const GITHUB_HEADERS = { accept: "application/vnd.github+json" } as const;

async function fetchJson<T>(
	fetchFn: typeof globalThis.fetch,
	url: string,
	token: string,
): Promise<T | undefined> {
	try {
		const res = await fetchFn(url, {
			headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` },
		});
		if (!res.ok) {
			return;
		}
		return (await res.json()) as T;
	} catch {
		return;
	}
}

async function fetchBearerUser(
	token: string,
	fetchFn: typeof globalThis.fetch,
): Promise<UserContext | undefined> {
	const [user, orgs, teams] = await Promise.all([
		fetchJson<GitHubUserPayload>(fetchFn, "https://api.github.com/user", token),
		fetchJson<GitHubOrgPayload[]>(
			fetchFn,
			"https://api.github.com/user/orgs",
			token,
		),
		fetchJson<GitHubTeamPayload[]>(
			fetchFn,
			"https://api.github.com/user/teams",
			token,
		),
	]);
	if (!user) {
		return;
	}
	return {
		name: user.login,
		mail: user.email ?? "",
		orgs: (orgs ?? []).map((o) => o.login),
		teams: (teams ?? []).map((t) => `${t.organization.login}:${t.slug}`),
	};
}

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

function userMiddleware(
	options: UserMiddlewareOptions = {},
): MiddlewareHandler {
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	return async (c, next) => {
		const headerUser = c.req.header("X-Auth-Request-User");
		if (headerUser) {
			const user = parseHeaderUser(
				headerUser,
				c.req.header("X-Auth-Request-Email") ?? "",
				c.req.header("X-Auth-Request-Groups") ?? "",
			);
			c.set("user", user);
			await next();
			return;
		}

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

declare module "hono" {
	interface ContextVariableMap {
		user: UserContext;
	}
}

export type { UserContext, UserMiddlewareOptions };
export { userMiddleware };
