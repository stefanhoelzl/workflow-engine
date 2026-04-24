import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { githubProviderFactory } from "./providers/github.js";
import { buildRegistry } from "./providers/index.js";
import { localProviderFactory } from "./providers/local.js";
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

function spinApp(opts: {
	authAllow: string;
	fetchFn: typeof globalThis.fetch;
}) {
	const registry = buildRegistry(
		opts.authAllow,
		[githubProviderFactory, localProviderFactory],
		{
			secureCookies: false,
			nowFn: () => Date.now(),
			fetchFn: opts.fetchFn,
			clientId: "cid",
			clientSecret: "csecret",
			baseUrl: "https://example.test",
		},
	);
	const loginMw = loginPageMiddleware({ secureCookies: false, registry });
	const authMw = authMiddleware({ secureCookies: false, registry });
	const sessionMw = sessionMiddleware({ registry, secureCookies: false });

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

const ALICE_ALLOW = "github:user:alice";

describe("integration: github sign-in flow", () => {
	it("unauth → /login → signin → callback → session", async () => {
		const fetchFn = fakeGitHub({ user: { login: "alice", email: null } });
		const app = spinApp({ authAllow: ALICE_ALLOW, fetchFn });

		const r1 = await app.request("/trigger");
		expect(r1.status).toBe(302);
		const loginUrl = r1.headers.get("location");
		expect(loginUrl).toBe("/login?returnTo=%2Ftrigger");

		const r2 = await app.request(loginUrl ?? "");
		expect(r2.status).toBe(200);
		const html = await r2.text();
		expect(html).toContain("Sign in with GitHub");
		expect(html).toContain("/auth/github/signin?returnTo=%2Ftrigger");

		const r3 = await app.request("/auth/github/signin?returnTo=/trigger");
		expect(r3.status).toBe(302);
		const authorizeUrl = r3.headers.get("location") ?? "";
		expect(authorizeUrl).toMatch(
			/^https:\/\/github\.com\/login\/oauth\/authorize\?/,
		);
		const stateMatch = authorizeUrl.match(/state=([^&]+)/);
		expect(stateMatch).not.toBeNull();
		const state = decodeURIComponent(stateMatch?.[1] ?? "");
		const stateCookie = cookieHeaderValue(
			r3.headers.getSetCookie(),
			"auth_state",
		);
		expect(stateCookie).toBeDefined();

		const r4 = await app.request(
			`/auth/github/callback?code=fake&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: stateCookie ?? "" } },
		);
		expect(r4.status).toBe(302);
		expect(r4.headers.get("location")).toBe("/trigger");
		const sessionCookie = cookieHeaderValue(
			r4.headers.getSetCookie(),
			"session",
		);
		expect(sessionCookie).toBeDefined();

		const r5 = await app.request("/trigger", {
			headers: { cookie: sessionCookie ?? "" },
		});
		expect(r5.status).toBe(200);
		expect(await r5.text()).toBe("TRIGGER OK");
	});

	it("denied user: callback → flash + 302 /login → deny banner", async () => {
		const fetchFn = fakeGitHub({ user: { login: "eve", email: null } });
		const app = spinApp({ authAllow: ALICE_ALLOW, fetchFn });

		const signin = await app.request("/auth/github/signin?returnTo=/trigger");
		const stateCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"auth_state",
		);
		const authorizeUrl = signin.headers.get("location") ?? "";
		const state = decodeURIComponent(
			authorizeUrl.match(/state=([^&]+)/)?.[1] ?? "",
		);

		const cb = await app.request(
			`/auth/github/callback?code=fake&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: stateCookie ?? "" } },
		);
		expect(cb.status).toBe(302);
		expect(cb.headers.get("location")).toBe("/login");
		const flashCookie = cookieHeaderValue(
			cb.headers.getSetCookie(),
			"auth_flash",
		);
		expect(flashCookie).toBeDefined();

		const login = await app.request("/login", {
			headers: { cookie: flashCookie ?? "" },
		});
		expect(login.status).toBe(200);
		const html = await login.text();
		expect(html).toContain("Not authorized");
		expect(html).toContain("eve");
		expect(html).toContain('href="https://github.com/logout"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).not.toContain("btn--secondary");
	});
});

describe("integration: local sign-in flow", () => {
	it("unauth → /login → POST signin → session → /trigger", async () => {
		const fetchFn = fakeGitHub();
		const app = spinApp({
			authAllow: "local:dev,local:alice:acme",
			fetchFn,
		});

		const r1 = await app.request("/trigger");
		expect(r1.status).toBe(302);
		expect(r1.headers.get("location")).toBe("/login?returnTo=%2Ftrigger");

		const r2 = await app.request("/login?returnTo=/trigger");
		const html = await r2.text();
		expect(html).toContain("/auth/local/signin");
		expect(html).toContain('value="dev"');
		expect(html).toContain('value="alice"');

		const signin = await app.request("/auth/local/signin", {
			method: "POST",
			body: new URLSearchParams({ user: "dev", returnTo: "/trigger" }),
		});
		expect(signin.status).toBe(302);
		expect(signin.headers.get("location")).toBe("/trigger");
		const sessionCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"session",
		);
		expect(sessionCookie).toBeDefined();

		const protected_ = await app.request("/trigger", {
			headers: { cookie: sessionCookie ?? "" },
		});
		expect(protected_.status).toBe(200);
		expect(await protected_.text()).toBe("TRIGGER OK");
	});
});

describe("integration: logout flow", () => {
	it("POST /auth/logout → 302 /login with flash → banner renders", async () => {
		const fetchFn = fakeGitHub({ user: { login: "alice", email: null } });
		const app = spinApp({ authAllow: ALICE_ALLOW, fetchFn });

		const signin = await app.request("/auth/github/signin?returnTo=/trigger");
		const state = decodeURIComponent(
			signin.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "",
		);
		const stateCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"auth_state",
		);
		const cb = await app.request(
			`/auth/github/callback?code=fake&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: stateCookie ?? "" } },
		);
		const sessionCookie = cookieHeaderValue(
			cb.headers.getSetCookie(),
			"session",
		);
		expect(sessionCookie).toBeDefined();

		const pre = await app.request("/trigger", {
			headers: { cookie: sessionCookie ?? "" },
		});
		expect(pre.status).toBe(200);

		const logout = await app.request("/auth/logout", {
			method: "POST",
			headers: { cookie: sessionCookie ?? "" },
		});
		expect(logout.status).toBe(302);
		expect(logout.headers.get("location")).toBe("/login");
		const setCookies = logout.headers.getSetCookie();
		const clearedSession = setCookies.find((c) => c.startsWith("session=;"));
		expect(clearedSession).toBeDefined();
		const flash = cookieHeaderValue(setCookies, "auth_flash");
		expect(flash).toBeDefined();

		const loginPage = await app.request("/login", {
			headers: { cookie: flash ?? "" },
		});
		expect(loginPage.status).toBe(200);
		const html = await loginPage.text();
		expect(html).toContain("Signed out");

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
		const app = spinApp({ authAllow: ALICE_ALLOW, fetchFn });

		const signin = await app.request("/auth/github/signin?returnTo=/trigger");
		const state = decodeURIComponent(
			signin.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "",
		);
		const stateCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"auth_state",
		);

		const cb = await app.request(
			`/auth/github/callback?code=fake&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: stateCookie ?? "" } },
		);
		expect(cb.status).toBe(502);
		expect(
			cb.headers.getSetCookie().find((c) => c.startsWith("session=")),
		).toBeUndefined();
	});

	it("state mismatch → 400", async () => {
		const fetchFn = fakeGitHub();
		const app = spinApp({ authAllow: ALICE_ALLOW, fetchFn });

		const signin = await app.request("/auth/github/signin?returnTo=/trigger");
		const stateCookie = cookieHeaderValue(
			signin.headers.getSetCookie(),
			"auth_state",
		);

		const cb = await app.request(
			"/auth/github/callback?code=fake&state=WRONG",
			{ headers: { cookie: stateCookie ?? "" } },
		);
		expect(cb.status).toBe(400);
	});
});
