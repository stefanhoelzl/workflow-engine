import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, STATE_COOKIE } from "../constants.js";
import { type SessionPayload, unsealSession } from "../session-cookie.js";
import { sealState } from "../state-cookie.js";
import { githubProviderFactory } from "./github.js";
import type { ProviderRouteDeps } from "./types.js";

const NOW = 1_700_000_000_000;

const DEPS: ProviderRouteDeps = {
	secureCookies: false,
	nowFn: () => NOW,
	clientId: "cid",
	clientSecret: "csecret",
	baseUrl: "https://example.test",
};

function depsWith(fetchFn: typeof globalThis.fetch): ProviderRouteDeps {
	return { ...DEPS, fetchFn };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

interface FakeGithubOpts {
	readonly user?: { login: string; email: string | null };
	readonly orgs?: ReadonlyArray<{ login: string }>;
	readonly tokenStatus?: number;
	readonly userStatus?: number;
	readonly orgsStatus?: number;
	readonly accessToken?: string;
}

function fakeGitHub(opts: FakeGithubOpts = {}) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = input.toString();
		if (url.endsWith("/login/oauth/access_token")) {
			if (opts.tokenStatus && opts.tokenStatus >= 400) {
				return jsonResponse({}, opts.tokenStatus);
			}
			return jsonResponse({ access_token: opts.accessToken ?? "gho_xxx" });
		}
		if (url.endsWith("/user/orgs")) {
			return jsonResponse(opts.orgs ?? [], opts.orgsStatus ?? 200);
		}
		if (url.endsWith("/user")) {
			return jsonResponse(
				opts.user ?? { login: "alice", email: null },
				opts.userStatus ?? 200,
			);
		}
		return jsonResponse({}, 404);
	});
}

function mountProvider(
	entries: readonly string[],
	deps: ProviderRouteDeps = DEPS,
): Hono {
	const provider = githubProviderFactory.create(entries, deps);
	const sub = new Hono();
	provider.mountAuthRoutes(sub);
	return sub;
}

function getSetCookies(res: Response): string[] {
	return res.headers.getSetCookie();
}

function findCookie(cookies: string[], name: string): string | undefined {
	return cookies.find((c) => c.startsWith(`${name}=`));
}

describe("create", () => {
	it('accepts ["user:alice"] and constructs an instance with id === "github"', () => {
		const provider = githubProviderFactory.create(["user:alice"], DEPS);
		expect(provider.id).toBe("github");
	});

	it('accepts ["user:alice", "org:acme"]', () => {
		const provider = githubProviderFactory.create(
			["user:alice", "org:acme"],
			DEPS,
		);
		expect(provider.id).toBe("github");
	});

	it('throws on ["team:eng"] (unknown kind)', () => {
		expect(() => githubProviderFactory.create(["team:eng"], DEPS)).toThrow(
			/unknown github kind "team"/,
		);
	});

	it('throws on ["user:has space"] (invalid identifier regex)', () => {
		expect(() =>
			githubProviderFactory.create(["user:has space"], DEPS),
		).toThrow(/invalid identifier "has space"/);
	});

	it('throws on ["user"] (malformed segment count)', () => {
		expect(() => githubProviderFactory.create(["user"], DEPS)).toThrow(
			/malformed github entry/,
		);
	});

	it('throws on ["user:alice:extra"] (too many segments)', () => {
		expect(() =>
			githubProviderFactory.create(["user:alice:extra"], DEPS),
		).toThrow(/malformed github entry/);
	});

	it("throws when deps lack clientId", () => {
		expect(() =>
			githubProviderFactory.create(["user:alice"], {
				secureCookies: false,
				nowFn: () => NOW,
			}),
		).toThrow(
			/github provider requires GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, and BASE_URL/,
		);
	});
});

describe("renderLoginSection", () => {
	it("returns markup containing Sign in with GitHub and the url-encoded returnTo", async () => {
		const provider = githubProviderFactory.create(["user:alice"], DEPS);
		const section = await provider.renderLoginSection("/dashboard/foo");
		const markup = String(section);
		expect(markup).toContain("Sign in with GitHub");
		expect(markup).toContain("/auth/github/signin?returnTo=%2Fdashboard%2Ffoo");
	});
});

describe("mountAuthRoutes", () => {
	it("GET /signin?returnTo=/dashboard redirects to github and sets state cookie", async () => {
		const sub = mountProvider(["user:alice"]);
		const res = await sub.request("/signin?returnTo=/dashboard");
		expect(res.status).toBe(302);
		const loc = res.headers.get("location") ?? "";
		expect(loc).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
		expect(loc).toContain("client_id=cid");
		expect(loc).toContain(
			"redirect_uri=https%3A%2F%2Fexample.test%2Fauth%2Fgithub%2Fcallback",
		);
		expect(findCookie(getSetCookies(res), STATE_COOKIE)).toBeDefined();
	});

	it("GET /callback happy path: sets session cookie with provider='github' and redirects to returnTo", async () => {
		const fetchFn = fakeGitHub({
			user: { login: "alice", email: "alice@example.com" },
			orgs: [{ login: "acme" }],
		});
		const sub = mountProvider(["user:alice"], depsWith(fetchFn));
		const sealed = await sealState({ state: "S", returnTo: "/dashboard/foo" });
		const res = await sub.request("/callback?code=c&state=S", {
			headers: { cookie: `${STATE_COOKIE}=${sealed}` },
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/dashboard/foo");
		const session = findCookie(getSetCookies(res), SESSION_COOKIE);
		expect(session).toBeDefined();
		const rawValue =
			session?.split(";")[0]?.split("=").slice(1).join("=") ?? "";
		const payload = await unsealSession(rawValue);
		expect(payload.provider).toBe("github");
		expect(payload.name).toBe("alice");
		expect(payload.mail).toBe("alice@example.com");
		expect(payload.accessToken).toBe("gho_xxx");
	});
});

describe("resolveApiIdentity", () => {
	it("returns user on Bearer token when github returns allowlisted user", async () => {
		const fetchFn = fakeGitHub({
			user: { login: "alice", email: null },
			orgs: [],
		});
		const provider = githubProviderFactory.create(
			["user:alice"],
			depsWith(fetchFn),
		);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "Bearer gho_xxx" },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toEqual({ name: "alice", mail: "", orgs: [] });
	});

	it("returns undefined when Authorization header missing", async () => {
		const fetchFn = fakeGitHub();
		const provider = githubProviderFactory.create(
			["user:alice"],
			depsWith(fetchFn),
		);
		const req = new Request("https://example.test/api/x");
		const user = await provider.resolveApiIdentity(req);
		expect(user).toBeUndefined();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("returns undefined for non-Bearer scheme", async () => {
		const fetchFn = fakeGitHub();
		const provider = githubProviderFactory.create(
			["user:alice"],
			depsWith(fetchFn),
		);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "Basic abc" },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toBeUndefined();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("returns undefined when github returns 401 on /user", async () => {
		const fetchFn = fakeGitHub({ userStatus: 401 });
		const provider = githubProviderFactory.create(
			["user:alice"],
			depsWith(fetchFn),
		);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "Bearer gho_xxx" },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toBeUndefined();
	});

	it("returns undefined when user is not on allowlist", async () => {
		const fetchFn = fakeGitHub({
			user: { login: "eve", email: null },
			orgs: [],
		});
		const provider = githubProviderFactory.create(
			["user:alice"],
			depsWith(fetchFn),
		);
		const req = new Request("https://example.test/api/x", {
			headers: { authorization: "Bearer gho_xxx" },
		});
		const user = await provider.resolveApiIdentity(req);
		expect(user).toBeUndefined();
	});
});

describe("refreshSession", () => {
	function mkPayload(): SessionPayload {
		return {
			provider: "github",
			name: "alice",
			mail: "alice@example.com",
			orgs: [],
			accessToken: "gho_xxx",
			resolvedAt: NOW,
			exp: NOW + 1000,
		};
	}

	it("returns UserContext on allowlisted user", async () => {
		const fetchFn = fakeGitHub({
			user: { login: "alice", email: "alice@example.com" },
			orgs: [{ login: "acme" }],
		});
		const provider = githubProviderFactory.create(
			["user:alice"],
			depsWith(fetchFn),
		);
		const user = await provider.refreshSession(mkPayload());
		expect(user).toEqual({
			name: "alice",
			mail: "alice@example.com",
			orgs: ["acme"],
		});
	});

	it("returns undefined when github returns 5xx", async () => {
		const fetchFn = fakeGitHub({ userStatus: 503 });
		const provider = githubProviderFactory.create(
			["user:alice"],
			depsWith(fetchFn),
		);
		const user = await provider.refreshSession(mkPayload());
		expect(user).toBeUndefined();
	});

	it("returns undefined when user is no longer on allowlist", async () => {
		const fetchFn = fakeGitHub({
			user: { login: "eve", email: null },
			orgs: [],
		});
		const provider = githubProviderFactory.create(
			["user:alice"],
			depsWith(fetchFn),
		);
		const user = await provider.refreshSession(mkPayload());
		expect(user).toBeUndefined();
	});
});
