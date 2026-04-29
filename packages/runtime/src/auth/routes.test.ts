import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
	FLASH_COOKIE,
	SESSION_COOKIE,
	SEVEN_DAYS_MS,
	STATE_COOKIE,
} from "./constants.js";
import { sealFlash } from "./flash-cookie.js";
import { githubProviderFactory } from "./providers/github.js";
import { buildRegistry, type ProviderRegistry } from "./providers/index.js";
import { localProviderFactory } from "./providers/local.js";
import { authMiddleware, loginPageMiddleware } from "./routes.js";
import { type SessionPayload, sealSession } from "./session-cookie.js";
import { sealState } from "./state-cookie.js";

interface MountOpts {
	authAllow: string;
	fetchFn?: typeof globalThis.fetch;
	nowFn?: () => number;
}

function mkRegistry(opts: MountOpts): ProviderRegistry {
	return buildRegistry(
		opts.authAllow,
		[githubProviderFactory, localProviderFactory],
		{
			secureCookies: false,
			nowFn: opts.nowFn ?? (() => Date.now()),
			...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
			clientId: "cid",
			clientSecret: "csecret",
			baseUrl: "https://example.test",
		},
	);
}

function mount(opts: MountOpts) {
	const registry = mkRegistry(opts);
	const loginMw = loginPageMiddleware({ secureCookies: false, registry });
	const authMw = authMiddleware({ secureCookies: false, registry });
	const app = new Hono();
	app.all(loginMw.match, loginMw.handler);
	app.all(authMw.match, authMw.handler);
	return app;
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function fakeGitHub(
	opts: {
		user?: { login: string; email: string | null };
		orgs?: Array<{ login: string }>;
		tokenStatus?: number;
		userStatus?: number;
		orgsStatus?: number;
		accessToken?: string;
	} = {},
) {
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

function getSetCookies(res: Response): string[] {
	return res.headers.getSetCookie();
}

function findCookie(cookies: string[], name: string): string | undefined {
	return cookies.find((c) => c.startsWith(`${name}=`));
}

const GH_ALLOW = "github:user:alice";

describe("GET /login", () => {
	it("renders the sign-in page without redirecting", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request("/login?returnTo=/dashboard");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Sign in with GitHub");
		// Login page is a single-card surface: no universal topbar, no
		// sidebar. Branding lives in the heading via .auth-card__brand.
		expect(html).not.toContain('class="topbar"');
		expect(html).not.toContain('class="topbar-brand"');
		expect(html).not.toContain('class="topbar-user"');
		expect(html).toContain('class="auth-card__brand"');
		expect(html).toContain("Workflow Engine");
		expect(html).not.toContain("sidebar");
		expect(html).toContain("/auth/github/signin?returnTo=%2Fdashboard");
	});

	it("renders an empty card when registry is empty", async () => {
		const app = mount({ authAllow: "" });
		const res = await app.request("/login");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain("Sign in with GitHub");
		expect(html).not.toContain("/auth/local/signin");
		expect(html).toContain("Workflow Engine");
	});

	it("renders the local-provider dropdown when local entries are present", async () => {
		const app = mount({ authAllow: "local:dev,local:alice" });
		const res = await app.request("/login");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("/auth/local/signin");
		expect(html).toContain('value="dev"');
		expect(html).toContain('value="alice"');
		expect(html).not.toContain("Sign in with GitHub");
	});

	it("renders both sections when both providers are registered", async () => {
		const app = mount({ authAllow: "github:user:alice,local:dev" });
		const res = await app.request("/login");
		const html = await res.text();
		expect(html).toContain("Sign in with GitHub");
		expect(html).toContain("/auth/local/signin");
	});

	it("does not set a state cookie (no OAuth flow started yet)", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request("/login");
		expect(findCookie(getSetCookies(res), STATE_COOKIE)).toBeUndefined();
	});

	it("renders deny banner when a flash cookie is present", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const flash = await sealFlash({
			kind: "denied",
			login: "eve",
		});
		const res = await app.request("/login", {
			headers: { cookie: `${FLASH_COOKIE}=${flash}` },
		});
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("eve");
		expect(html).toContain("Not authorized");
		expect(html).toContain('href="https://github.com/logout"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).not.toContain("btn--secondary");
		const cleared = findCookie(getSetCookies(res), FLASH_COOKIE);
		expect(cleared).toContain("Max-Age=0");
	});

	it("refreshing the page without a flash stays on the sign-in page (no auto-redirect)", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request("/login");
		expect(res.status).toBe(200);
		expect(res.headers.get("location")).toBeNull();
	});

	it("sanitises unsafe returnTo", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request("/login?returnTo=//evil.example/");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain("evil.example");
		expect(html).toContain("returnTo=%2F");
	});
});

describe("GET /auth/github/signin", () => {
	it("redirects to GitHub authorize with a state cookie", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request("/auth/github/signin?returnTo=/dashboard");
		expect(res.status).toBe(302);
		const loc = res.headers.get("location");
		expect(loc).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
		expect(loc).toContain("scope=user%3Aemail+read%3Aorg");
		expect(loc).toContain(
			"redirect_uri=https%3A%2F%2Fexample.test%2Fauth%2Fgithub%2Fcallback",
		);
		expect(findCookie(getSetCookies(res), STATE_COOKIE)).toBeDefined();
	});

	it("sanitises unsafe returnTo before sealing it into the state cookie", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request(
			"/auth/github/signin?returnTo=//evil.example/",
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).not.toContain("evil.example");
	});
});

describe("GET /auth/github/callback", () => {
	async function stateCookie(state: string, returnTo = "/dashboard") {
		const sealed = await sealState({ state, returnTo });
		return `${STATE_COOKIE}=${sealed}`;
	}

	it("returns 400 on state mismatch", async () => {
		const cookie = await stateCookie("A");
		const app = mount({ authAllow: GH_ALLOW, fetchFn: fakeGitHub() });
		const res = await app.request("/auth/github/callback?code=c&state=B", {
			headers: { cookie },
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 when state cookie missing", async () => {
		const app = mount({ authAllow: GH_ALLOW, fetchFn: fakeGitHub() });
		const res = await app.request("/auth/github/callback?code=c&state=X");
		expect(res.status).toBe(400);
	});

	it("returns 502 when token exchange fails", async () => {
		const cookie = await stateCookie("S");
		const app = mount({
			authAllow: GH_ALLOW,
			fetchFn: fakeGitHub({ tokenStatus: 500 }),
		});
		const res = await app.request("/auth/github/callback?code=c&state=S", {
			headers: { cookie },
		});
		expect(res.status).toBe(502);
	});

	it("sets session cookie and redirects to returnTo on allowed user", async () => {
		const cookie = await stateCookie("S", "/dashboard/foo");
		const app = mount({
			authAllow: GH_ALLOW,
			fetchFn: fakeGitHub({
				user: { login: "alice", email: null },
				orgs: [],
			}),
		});
		const res = await app.request("/auth/github/callback?code=c&state=S", {
			headers: { cookie },
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/dashboard/foo");
		const session = findCookie(getSetCookies(res), SESSION_COOKIE);
		expect(session).toBeDefined();
		expect(session ?? "").not.toContain("Max-Age=0");
	});

	it("sets flash and redirects to login when user not allowed", async () => {
		const cookie = await stateCookie("S");
		const app = mount({
			authAllow: GH_ALLOW,
			fetchFn: fakeGitHub({
				user: { login: "eve", email: null },
				orgs: [],
			}),
		});
		const res = await app.request("/auth/github/callback?code=c&state=S", {
			headers: { cookie },
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		const set = getSetCookies(res);
		const flash = findCookie(set, FLASH_COOKIE);
		expect(flash).toBeDefined();
		const clearedSession = set.find((c) => c.startsWith(`${SESSION_COOKIE}=;`));
		expect(clearedSession).toBeDefined();
	});
});

describe("POST /auth/local/signin", () => {
	it("seals a local session and redirects to returnTo", async () => {
		const app = mount({ authAllow: "local:dev" });
		const res = await app.request("/auth/local/signin", {
			method: "POST",
			body: new URLSearchParams({ user: "dev", returnTo: "/dashboard" }),
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/dashboard");
		const session = findCookie(getSetCookies(res), SESSION_COOKIE);
		expect(session).toBeDefined();
		expect(session ?? "").not.toContain("Max-Age=0");
	});

	it("returns 400 for unknown local user", async () => {
		const app = mount({ authAllow: "local:dev" });
		const res = await app.request("/auth/local/signin", {
			method: "POST",
			body: new URLSearchParams({ user: "mallory", returnTo: "/" }),
		});
		expect(res.status).toBe(400);
		expect(findCookie(getSetCookies(res), SESSION_COOKIE)).toBeUndefined();
	});

	it("sanitises returnTo to / when malformed", async () => {
		const app = mount({ authAllow: "local:dev" });
		const res = await app.request("/auth/local/signin", {
			method: "POST",
			body: new URLSearchParams({
				user: "dev",
				returnTo: "//evil.example",
			}),
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/");
	});
});

describe("/auth/logout", () => {
	it("POST clears session cookie, sets logged-out flash, redirects to login", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request("/auth/logout", { method: "POST" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		const set = getSetCookies(res);
		const cleared = findCookie(set, SESSION_COOKIE);
		expect(cleared).toContain("Max-Age=0");
		const flash = findCookie(set, FLASH_COOKIE);
		expect(flash).toBeDefined();
	});

	it("GET returns 405", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request("/auth/logout");
		expect(res.status).toBe(405);
	});

	it("PUT returns 405", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const res = await app.request("/auth/logout", { method: "PUT" });
		expect(res.status).toBe(405);
	});

	it("login page after github logout renders a clean signed-out banner with no GitHub logout affordance", async () => {
		const app = mount({ authAllow: GH_ALLOW });
		const now = 1_700_000_000_000;
		const sealedSession = await sealSession({
			provider: "github",
			login: "alice",
			mail: "alice@x",
			orgs: [],
			accessToken: "gho_xxx",
			resolvedAt: now,
			exp: now + SEVEN_DAYS_MS,
		} satisfies SessionPayload);
		const logoutRes = await app.request("/auth/logout", {
			method: "POST",
			headers: { cookie: `${SESSION_COOKIE}=${sealedSession}` },
		});
		const flash = findCookie(getSetCookies(logoutRes), FLASH_COOKIE);
		const flashValue =
			flash?.split(";")[0]?.split("=").slice(1).join("=") ?? "";
		const loginRes = await app.request("/login", {
			headers: { cookie: `${FLASH_COOKIE}=${flashValue}` },
		});
		expect(loginRes.status).toBe(200);
		const html = await loginRes.text();
		expect(html).toContain("Signed out");
		expect(html).toContain("Sign in with GitHub");
		expect(html).not.toContain("github.com/logout");
		expect(html).not.toContain("Sign out of GitHub");
		expect(html).not.toContain("GitHub may");
	});

	it("login page after sessionless logout is a clean signed-out banner", async () => {
		const app = mount({ authAllow: "local:dev" });
		const logoutRes = await app.request("/auth/logout", { method: "POST" });
		const flash = findCookie(getSetCookies(logoutRes), FLASH_COOKIE);
		const flashValue =
			flash?.split(";")[0]?.split("=").slice(1).join("=") ?? "";
		const loginRes = await app.request("/login", {
			headers: { cookie: `${FLASH_COOKIE}=${flashValue}` },
		});
		const html = await loginRes.text();
		expect(html).toContain("Signed out");
		expect(html).not.toContain("github.com/logout");
	});
});
