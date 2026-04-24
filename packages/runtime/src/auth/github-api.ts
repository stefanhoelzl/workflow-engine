import type { UserContext } from "./user-context.js";

const OAUTH_BASE = "https://github.com/login/oauth";
const API_BASE = "https://api.github.com";
const GITHUB_ACCEPT = "application/vnd.github+json" as const;
const OAUTH_SCOPES = "user:email read:org" as const;

type Result<T> = { ok: true; data: T } | { ok: false; status: number };

interface AuthorizeUrlInput {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly state: string;
}

function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
	const u = new URL(`${OAUTH_BASE}/authorize`);
	u.searchParams.set("client_id", input.clientId);
	u.searchParams.set("redirect_uri", input.redirectUri);
	u.searchParams.set("scope", OAUTH_SCOPES);
	u.searchParams.set("state", input.state);
	return u.toString();
}

interface ExchangeCodeInput {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly code: string;
	readonly redirectUri: string;
	readonly fetchFn?: typeof globalThis.fetch;
}

interface AccessTokenResponse {
	readonly accessToken: string;
}

async function exchangeCode(
	input: ExchangeCodeInput,
): Promise<Result<AccessTokenResponse>> {
	const fetchFn = input.fetchFn ?? globalThis.fetch;
	let res: Response;
	try {
		res = await fetchFn(`${OAUTH_BASE}/access_token`, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				// biome-ignore lint/style/useNamingConvention: GitHub OAuth wire protocol
				client_id: input.clientId,
				// biome-ignore lint/style/useNamingConvention: GitHub OAuth wire protocol
				client_secret: input.clientSecret,
				code: input.code,
				// biome-ignore lint/style/useNamingConvention: GitHub OAuth wire protocol
				redirect_uri: input.redirectUri,
			}),
		});
	} catch {
		return { ok: false, status: 0 };
	}
	if (!res.ok) {
		return { ok: false, status: res.status };
	}
	// biome-ignore lint/style/useNamingConvention: GitHub OAuth wire protocol
	let body: { access_token?: string; error?: string };
	try {
		body = (await res.json()) as typeof body;
	} catch {
		return { ok: false, status: res.status };
	}
	if (typeof body.access_token !== "string" || body.access_token === "") {
		// GitHub returns 200 even on failure; the body carries `error`.
		return { ok: false, status: res.status };
	}
	return { ok: true, data: { accessToken: body.access_token } };
}

interface UserFetch {
	readonly accessToken: string;
	readonly fetchFn?: typeof globalThis.fetch;
}

interface GitHubUser {
	readonly login: string;
	readonly email: string | null;
}

interface GitHubOrg {
	readonly login: string;
}

async function fetchGitHub<T>(
	url: string,
	accessToken: string,
	fetchFn: typeof globalThis.fetch,
): Promise<Result<T>> {
	let res: Response;
	try {
		res = await fetchFn(url, {
			headers: {
				accept: GITHUB_ACCEPT,
				authorization: `Bearer ${accessToken}`,
			},
		});
	} catch {
		return { ok: false, status: 0 };
	}
	if (!res.ok) {
		return { ok: false, status: res.status };
	}
	try {
		return { ok: true, data: (await res.json()) as T };
	} catch {
		return { ok: false, status: res.status };
	}
}

async function fetchUser(input: UserFetch): Promise<Result<GitHubUser>> {
	const fetchFn = input.fetchFn ?? globalThis.fetch;
	return await fetchGitHub<GitHubUser>(
		`${API_BASE}/user`,
		input.accessToken,
		fetchFn,
	);
}

async function fetchOrgs(input: UserFetch): Promise<Result<GitHubOrg[]>> {
	const fetchFn = input.fetchFn ?? globalThis.fetch;
	return await fetchGitHub<GitHubOrg[]>(
		`${API_BASE}/user/orgs`,
		input.accessToken,
		fetchFn,
	);
}

async function resolveUser(input: UserFetch): Promise<Result<UserContext>> {
	const [userRes, orgsRes] = await Promise.all([
		fetchUser(input),
		fetchOrgs(input),
	]);
	if (!userRes.ok) {
		return userRes;
	}
	if (!orgsRes.ok) {
		return orgsRes;
	}
	const login = userRes.data.login;
	return {
		ok: true,
		data: {
			login,
			mail: userRes.data.email ?? "",
			orgs: [login, ...orgsRes.data.map((o) => o.login)],
		},
	};
}

export type { ExchangeCodeInput, GitHubOrg, GitHubUser, Result, UserFetch };
export {
	API_BASE,
	buildAuthorizeUrl,
	exchangeCode,
	fetchOrgs,
	fetchUser,
	OAUTH_BASE,
	OAUTH_SCOPES,
	resolveUser,
};
