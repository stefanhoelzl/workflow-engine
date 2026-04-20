import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Auth } from "./allowlist.js";
import { FLASH_COOKIE, SESSION_COOKIE, STATE_COOKIE } from "./constants.js";
import { sealFlash } from "./flash-cookie.js";
import { authMiddleware, loginPageMiddleware } from "./routes.js";
import { sealState } from "./state-cookie.js";

const RESTRICTED: Auth = {
	mode: "restricted",
	users: new Set(["alice"]),
	orgs: new Set(),
};

function mount(
	auth: Auth,
	fetchFn?: typeof globalThis.fetch,
	nowFn: () => number = () => Date.now(),
) {
	const opts = {
		auth,
		clientId: "cid",
		clientSecret: "csecret",
		baseUrl: "https://example.test",
		secureCookies: false,
		...(fetchFn ? { fetchFn } : {}),
		nowFn,
	};
	const loginMw = loginPageMiddleware(opts);
	const authMw = authMiddleware(opts);
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

describe("GET /login", () => {
	it("renders the sign-in page without redirecting", async () => {
		const app = mount(RESTRICTED);
		const res = await app.request("/login?returnTo=/dashboard");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Sign in with GitHub");
		expect(html).not.toContain("topbar");
		expect(html).not.toContain("sidebar");
		expect(html).toContain("/auth/github/signin?returnTo=%2Fdashboard");
	});

	it("does not set a state cookie (no OAuth flow started yet)", async () => {
		const app = mount(RESTRICTED);
		const res = await app.request("/login");
		expect(findCookie(getSetCookies(res), STATE_COOKIE)).toBeUndefined();
	});

	it("renders deny banner when a flash cookie is present", async () => {
		const app = mount(RESTRICTED);
		const flash = await sealFlash({ kind: "denied", login: "eve" });
		const res = await app.request("/login", {
			headers: { cookie: `${FLASH_COOKIE}=${flash}` },
		});
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("eve");
		expect(html).toContain("Not authorized");
		expect(html).toContain("Sign in with GitHub");
		const cleared = findCookie(getSetCookies(res), FLASH_COOKIE);
		expect(cleared).toContain("Max-Age=0");
	});

	it("refreshing the page without a flash stays on the sign-in page (no auto-redirect)", async () => {
		const app = mount(RESTRICTED);
		const res = await app.request("/login");
		expect(res.status).toBe(200);
		expect(res.headers.get("location")).toBeNull();
	});

	it("sanitises unsafe returnTo", async () => {
		const app = mount(RESTRICTED);
		const res = await app.request("/login?returnTo=//evil.example/");
		expect(res.status).toBe(200);
		const html = await res.text();
		// Sanitised to "/"; no evil.example leaks into the sign-in href.
		expect(html).not.toContain("evil.example");
		expect(html).toContain("returnTo=%2F");
	});
});

describe("GET /auth/github/signin", () => {
	it("redirects to GitHub authorize with a state cookie", async () => {
		const app = mount(RESTRICTED);
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
		const app = mount(RESTRICTED);
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
		const app = mount(RESTRICTED, fakeGitHub());
		const res = await app.request("/auth/github/callback?code=c&state=B", {
			headers: { cookie },
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 when state cookie missing", async () => {
		const app = mount(RESTRICTED, fakeGitHub());
		const res = await app.request("/auth/github/callback?code=c&state=X");
		expect(res.status).toBe(400);
	});

	it("returns 502 when token exchange fails", async () => {
		const cookie = await stateCookie("S");
		const app = mount(RESTRICTED, fakeGitHub({ tokenStatus: 500 }));
		const res = await app.request("/auth/github/callback?code=c&state=S", {
			headers: { cookie },
		});
		expect(res.status).toBe(502);
	});

	it("sets session cookie and redirects to returnTo on allowed user", async () => {
		const cookie = await stateCookie("S", "/dashboard/foo");
		const app = mount(
			RESTRICTED,
			fakeGitHub({ user: { login: "alice", email: null }, orgs: [] }),
		);
		const res = await app.request("/auth/github/callback?code=c&state=S", {
			headers: { cookie },
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/dashboard/foo");
		const session = findCookie(getSetCookies(res), SESSION_COOKIE);
		expect(session).toBeDefined();
		expect(session!).not.toContain("Max-Age=0");
	});

	it("sets flash and redirects to login when user not allowed", async () => {
		const cookie = await stateCookie("S");
		const app = mount(
			RESTRICTED,
			fakeGitHub({ user: { login: "eve", email: null }, orgs: [] }),
		);
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

describe("/auth/logout", () => {
	it("POST clears session cookie, sets logged-out flash, redirects to login", async () => {
		const app = mount(RESTRICTED);
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
		const app = mount(RESTRICTED);
		const res = await app.request("/auth/logout");
		expect(res.status).toBe(405);
	});

	it("PUT returns 405", async () => {
		const app = mount(RESTRICTED);
		const res = await app.request("/auth/logout", { method: "PUT" });
		expect(res.status).toBe(405);
	});

	it("login page renders signed-out banner when reached via logout flash", async () => {
		const app = mount(RESTRICTED);
		const logoutRes = await app.request("/auth/logout", { method: "POST" });
		const flash = findCookie(getSetCookies(logoutRes), FLASH_COOKIE);
		const flashValue = flash!.split(";")[0]!.split("=").slice(1).join("=");
		const loginRes = await app.request("/login", {
			headers: { cookie: `${FLASH_COOKIE}=${flashValue}` },
		});
		expect(loginRes.status).toBe(200);
		const html = await loginRes.text();
		expect(html).toContain("Signed out");
		expect(html).toContain("Sign in with GitHub");
		// Secondary "Sign out of GitHub" is shown so users who really want to
		// end their session can kill the IdP-side grant that would otherwise
		// silently re-authenticate them.
		expect(html).toContain("github.com/logout");
	});
});
