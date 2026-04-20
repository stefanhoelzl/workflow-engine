import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Auth } from "./allowlist.js";
import { authMiddleware, loginPageMiddleware } from "./routes.js";
import { sessionMiddleware } from "./session-mw.js";

interface FakeGitHubOpts {
	readonly user?: { login: string; email: string | null };
	readonly orgs?: Array<{ login: string }>;
}

function fakeGitHub(opts: FakeGitHubOpts = {}) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = input.toString();
		if (url.endsWith("/login/oauth/access_token")) {
			return new Response(JSON.stringify({ access_token: "gho_fake" }), {
				status: 200,
			});
		}
		if (url.endsWith("/user/orgs")) {
			return new Response(JSON.stringify(opts.orgs ?? []), { status: 200 });
		}
		if (url.endsWith("/user")) {
			return new Response(
				JSON.stringify(opts.user ?? { login: "alice", email: null }),
				{ status: 200 },
			);
		}
		return new Response("{}", { status: 404 });
	});
}

function spinApp(opts: { auth: Auth; fetchFn: typeof globalThis.fetch }) {
	const middlewareOpts = {
		auth: opts.auth,
		clientId: "cid",
		clientSecret: "csecret",
		baseUrl: "https://example.test",
		secureCookies: false,
		fetchFn: opts.fetchFn,
	};
	const loginMw = loginPageMiddleware(middlewareOpts);
	const authMw = authMiddleware(middlewareOpts);
	const sessionMw = sessionMiddleware(middlewareOpts);

	const app = new Hono();
	app.all(loginMw.match, loginMw.handler);
	app.all(authMw.match, authMw.handler);
	// Protected surface used by the tests.
	app.use("/trigger/*", sessionMw);
	app.use("/trigger", sessionMw);
	app.get("/trigger", (c) => c.text("TRIGGER OK"));
	return app;
}

function cookieHeaderValue(
	setCookies: string[],
	name: string,
): string | undefined {
	const entry = setCookies.find((c) => c.startsWith(`${name}=`));
	if (!entry) {
		return;
	}
	return entry.split(";")[0];
}

const ALICE_ALLOW: Auth = {
	mode: "restricted",
	users: new Set(["alice"]),
	orgs: new Set(),
};

describe("integration: sign-in flow", () => {
	it("unauth → /login → signin → callback → session", async () => {
		const fetchFn = fakeGitHub({ user: { login: "alice", email: null } });
		const app = spinApp({ auth: ALICE_ALLOW, fetchFn });

		// 1. Unauthenticated /trigger → 302 /login?returnTo=/trigger
		const r1 = await app.request("/trigger");
		expect(r1.status).toBe(302);
		const loginUrl = r1.headers.get("location");
		expect(loginUrl).toBe("/login?returnTo=%2Ftrigger");

		// 2. Follow to /login → 200 renders sign-in page with the GH button
		const r2 = await app.request(loginUrl!);
		expect(r2.status).toBe(200);
		const html = await r2.text();
		expect(html).toContain("Sign in with GitHub");
		expect(html).toContain("/auth/github/signin?returnTo=%2Ftrigger");
		expect(html).not.toContain("topbar");

		// 3. Click "Sign in with GitHub" → GET /auth/github/signin → 302 GitHub
		const r3 = await app.request("/auth/github/signin?returnTo=/trigger");
		expect(r3.status).toBe(302);
		const authorizeUrl = r3.headers.get("location");
		expect(authorizeUrl).toMatch(
			/^https:\/\/github\.com\/login\/oauth\/authorize\?/,
		);
		const stateMatch = authorizeUrl!.match(/state=([^&]+)/);
		expect(stateMatch).not.toBeNull();
		const state = decodeURIComponent(stateMatch![1]!);
		const stateCookie = cookieHeaderValue(
			r3.headers.getSetCookie(),
			"auth_state",
		);
		expect(stateCookie).toBeDefined();

		// 4. Fake GitHub redirects back → GET /auth/github/callback
		//    → 302 returnTo with session cookie
		const r4 = await app.request(
			`/auth/github/callback?code=fake&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: stateCookie! } },
		);
		expect(r4.status).toBe(302);
		expect(r4.headers.get("location")).toBe("/trigger");
		const sessionCookie = cookieHeaderValue(
			r4.headers.getSetCookie(),
			"session",
		);
		expect(sessionCookie).toBeDefined();

		// 5. Hit /trigger with the session cookie → 200 handler body
		const r5 = await app.request("/trigger", {
			headers: { cookie: sessionCookie! },
		});
		expect(r5.status).toBe(200);
		expect(await r5.text()).toBe("TRIGGER OK");
	});

	it("denied user: callback → flash + 302 /login → signed-out deny banner", async () => {
		// Allowlist excludes the GitHub login we'll be logged in as.
		const fetchFn = fakeGitHub({ user: { login: "eve", email: null } });
		const app = spinApp({ auth: ALICE_ALLOW, fetchFn });

		// Kick off the flow from /auth/github/signin to get a state cookie.
		const signin = await app.request("/auth/github/signin?returnTo=/trigger");
		const stateCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"auth_state",
		);
		const authorizeUrl = signin.headers.get("location");
		const state = decodeURIComponent(authorizeUrl!.match(/state=([^&]+)/)![1]!);

		// Callback: user is "eve", allowlist has "alice" → reject, 302 /login
		// with a flash cookie.
		const cb = await app.request(
			`/auth/github/callback?code=fake&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: stateCookie! } },
		);
		expect(cb.status).toBe(302);
		expect(cb.headers.get("location")).toBe("/login");
		const flashCookie = cookieHeaderValue(
			cb.headers.getSetCookie(),
			"auth_flash",
		);
		expect(flashCookie).toBeDefined();

		// Follow to /login with the flash cookie → banner page shows "eve"
		const login = await app.request("/login", {
			headers: { cookie: flashCookie! },
		});
		expect(login.status).toBe(200);
		const html = await login.text();
		expect(html).toContain("Not authorized");
		expect(html).toContain("eve");
		// Secondary action is available to let the user switch accounts.
		expect(html).toContain("github.com/logout");
	});
});

describe("integration: logout flow", () => {
	it("POST /auth/logout → 302 /login with flash → banner renders", async () => {
		const fetchFn = fakeGitHub({ user: { login: "alice", email: null } });
		const app = spinApp({ auth: ALICE_ALLOW, fetchFn });

		// Complete the sign-in flow to get a valid session cookie.
		const signin = await app.request("/auth/github/signin?returnTo=/trigger");
		const state = decodeURIComponent(
			signin.headers.get("location")!.match(/state=([^&]+)/)![1]!,
		);
		const stateCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"auth_state",
		);
		const cb = await app.request(
			`/auth/github/callback?code=fake&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: stateCookie! } },
		);
		const sessionCookie = cookieHeaderValue(
			cb.headers.getSetCookie(),
			"session",
		);
		expect(sessionCookie).toBeDefined();

		// Confirm we're signed in on /trigger.
		const pre = await app.request("/trigger", {
			headers: { cookie: sessionCookie! },
		});
		expect(pre.status).toBe(200);

		// Sign out.
		const logout = await app.request("/auth/logout", {
			method: "POST",
			headers: { cookie: sessionCookie! },
		});
		expect(logout.status).toBe(302);
		expect(logout.headers.get("location")).toBe("/login");
		const setCookies = logout.headers.getSetCookie();
		// session cleared
		const clearedSession = setCookies.find((c) => c.startsWith("session=;"));
		expect(clearedSession).toBeDefined();
		// flash set
		const flash = cookieHeaderValue(setCookies, "auth_flash");
		expect(flash).toBeDefined();

		// /login with the logout flash → "Signed out" banner.
		const loginPage = await app.request("/login", {
			headers: { cookie: flash! },
		});
		expect(loginPage.status).toBe(200);
		const html = await loginPage.text();
		expect(html).toContain("Signed out");

		// Hitting /trigger after logout (no session) → 302 back to /login.
		const postLogoutTrigger = await app.request("/trigger");
		expect(postLogoutTrigger.status).toBe(302);
		expect(postLogoutTrigger.headers.get("location")).toMatch(
			/^\/login\?returnTo=/,
		);
	});
});

describe("integration: callback failure modes", () => {
	it("token exchange failure → 502, no session cookie", async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.endsWith("/login/oauth/access_token")) {
				return new Response("{}", { status: 500 });
			}
			return new Response("{}", { status: 404 });
		});
		const app = spinApp({ auth: ALICE_ALLOW, fetchFn });

		const signin = await app.request("/auth/github/signin?returnTo=/trigger");
		const state = decodeURIComponent(
			signin.headers.get("location")!.match(/state=([^&]+)/)![1]!,
		);
		const stateCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"auth_state",
		);

		const cb = await app.request(
			`/auth/github/callback?code=fake&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: stateCookie! } },
		);
		expect(cb.status).toBe(502);
		expect(
			cb.headers.getSetCookie().find((c) => c.startsWith("session=")),
		).toBeUndefined();
	});

	it("state mismatch → 400", async () => {
		const fetchFn = fakeGitHub();
		const app = spinApp({ auth: ALICE_ALLOW, fetchFn });

		const signin = await app.request("/auth/github/signin?returnTo=/trigger");
		const stateCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"auth_state",
		);

		const cb = await app.request(
			"/auth/github/callback?code=fake&state=WRONG",
			{ headers: { cookie: stateCookie! } },
		);
		expect(cb.status).toBe(400);
	});
});
