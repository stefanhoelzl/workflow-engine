import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Auth } from "./allowlist.js";
import { FLASH_COOKIE, SESSION_COOKIE, SEVEN_DAYS_MS } from "./constants.js";
import { unsealFlash } from "./flash-cookie.js";
import { type SessionPayload, sealSession } from "./session-cookie.js";
import { sessionMiddleware } from "./session-mw.js";

const RESTRICTED: Auth = {
	mode: "restricted",
	users: new Set(["alice"]),
	orgs: new Set(["acme"]),
};

function mkApp(
	auth: Auth,
	fetchFn?: typeof globalThis.fetch,
	nowFn: () => number = () => Date.now(),
) {
	const app = new Hono();
	app.use(
		"*",
		sessionMiddleware({
			auth,
			secureCookies: false,
			...(fetchFn ? { fetchFn } : {}),
			nowFn,
		}),
	);
	app.get("/protected", (c) => {
		const user = c.get("user");
		return c.json({ user: user ?? null, authOpen: c.get("authOpen") ?? false });
	});
	return app;
}

function fakeFetch(map: Record<string, { body: unknown; status?: number }>) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = input.toString();
		for (const [suffix, res] of Object.entries(map)) {
			if (url.endsWith(suffix)) {
				return new Response(JSON.stringify(res.body), {
					status: res.status ?? 200,
				});
			}
		}
		return new Response("{}", { status: 404 });
	});
}

async function freshCookie(
	over: Partial<SessionPayload> = {},
): Promise<{ cookie: string; payload: SessionPayload }> {
	const now = 1_700_000_000_000;
	const payload: SessionPayload = {
		name: "alice",
		mail: "alice@x",
		orgs: ["acme"],
		accessToken: "gho_xxx",
		resolvedAt: now,
		exp: now + SEVEN_DAYS_MS,
		...over,
	};
	const cookie = `${SESSION_COOKIE}=${await sealSession(payload)}`;
	return { cookie, payload };
}

describe("sessionMiddleware", () => {
	it("returns 401 in disabled mode", async () => {
		const app = mkApp({ mode: "disabled" });
		const res = await app.request("/protected");
		expect(res.status).toBe(401);
	});

	it("passes through with authOpen=true in open mode", async () => {
		const app = mkApp({ mode: "open" });
		const res = await app.request("/protected");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			user: unknown;
			authOpen: boolean;
		};
		expect(body.user).toBeNull();
		expect(body.authOpen).toBe(true);
	});

	it("redirects to /login when no session cookie", async () => {
		const app = mkApp(RESTRICTED);
		const res = await app.request("/protected");
		expect(res.status).toBe(302);
		const loc = res.headers.get("location");
		expect(loc).toMatch(/^\/login\?returnTo=/);
	});

	it("passes through on fresh session with allowed user", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 1000 });
		const app = mkApp(RESTRICTED, undefined, () => now);
		const res = await app.request("/protected", {
			headers: { cookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { name: string } };
		expect(body.user.name).toBe("alice");
	});

	it("redirects with flash when allowed-at-seal user is now rejected", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({
			resolvedAt: now - 1000,
			name: "exile",
			orgs: ["stale-org"],
		});
		const app = mkApp(RESTRICTED, undefined, () => now);
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		// flash cookie set
		const setCookies = res.headers.getSetCookie();
		const flash = setCookies.find((c) => c.startsWith(`${FLASH_COOKIE}=`));
		expect(flash).toBeDefined();
		const flashValue = flash!.split(";")[0]!.split("=")[1]!;
		await expect(unsealFlash(flashValue)).resolves.toEqual({
			kind: "denied",
			login: "exile",
		});
		const sessionCleared = setCookies.find((c) =>
			c.startsWith(`${SESSION_COOKIE}=;`),
		);
		expect(sessionCleared).toBeDefined();
	});

	it("refreshes on stale session and re-seals", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 60 * 60_000 });
		const fetchFn = fakeFetch({
			"/user": { body: { login: "alice", email: "alice@x" } },
			"/user/orgs": { body: [{ login: "acme" }] },
		});
		const app = mkApp(RESTRICTED, fetchFn, () => now);
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(fetchFn).toHaveBeenCalled();
		const setCookies = res.headers.getSetCookie();
		const session = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
		expect(session).toBeDefined();
	});

	it("fails closed when GitHub returns 5xx on refresh", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 60 * 60_000 });
		const fetchFn = fakeFetch({
			"/user": { body: {}, status: 500 },
			"/user/orgs": { body: [{ login: "acme" }] },
		});
		const app = mkApp(RESTRICTED, fetchFn, () => now);
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/^\/login/);
		const setCookies = res.headers.getSetCookie();
		const sessionCleared = setCookies.find((c) =>
			c.startsWith(`${SESSION_COOKIE}=;`),
		);
		expect(sessionCleared).toBeDefined();
	});

	it("fails closed when GitHub returns 401 on refresh (token revoked)", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 60 * 60_000 });
		const fetchFn = fakeFetch({
			"/user": { body: {}, status: 401 },
		});
		const app = mkApp(RESTRICTED, fetchFn, () => now);
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/^\/login/);
	});

	it("bounces with flash when refresh finds user now outside allow-list", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 60 * 60_000 });
		const fetchFn = fakeFetch({
			"/user": { body: { login: "alice", email: null } },
			"/user/orgs": { body: [] }, // left acme
		});
		// allow-list requires either "alice" user or "acme" org.
		// Allow-list-at-refresh check still matches on user name; flip name too
		// to test the rejection path.
		const strictAuth: Auth = {
			mode: "restricted",
			users: new Set(["other"]),
			orgs: new Set(["acme"]),
		};
		const app = mkApp(strictAuth, fetchFn, () => now);
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		const setCookies = res.headers.getSetCookie();
		const flash = setCookies.find((c) => c.startsWith(`${FLASH_COOKIE}=`));
		expect(flash).toBeDefined();
	});

	it("redirects on expired (hard TTL exceeded) session", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ exp: now - 1 });
		const app = mkApp(RESTRICTED, undefined, () => now);
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/^\/login/);
	});

	it("redirects on tampered cookie", async () => {
		const { cookie } = await freshCookie();
		const tampered = `${cookie.slice(0, -2)}XX`;
		const app = mkApp(RESTRICTED);
		const res = await app.request("/protected", {
			headers: { cookie: tampered },
		});
		expect(res.status).toBe(302);
	});
});
