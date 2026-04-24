import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { FLASH_COOKIE, SESSION_COOKIE, SEVEN_DAYS_MS } from "./constants.js";
import { unsealFlash } from "./flash-cookie.js";
import { githubProviderFactory } from "./providers/github.js";
import { buildRegistry, type ProviderRegistry } from "./providers/index.js";
import { localProviderFactory } from "./providers/local.js";
import {
	type SessionPayload,
	type SessionProvider,
	sealSession,
} from "./session-cookie.js";
import { sessionMiddleware } from "./session-mw.js";

interface MkAppOpts {
	authAllow: string;
	fetchFn?: typeof globalThis.fetch;
	nowFn?: () => number;
}

function mkRegistry(opts: MkAppOpts): ProviderRegistry {
	return buildRegistry(
		opts.authAllow,
		[githubProviderFactory, localProviderFactory],
		{
			secureCookies: false,
			nowFn: opts.nowFn ?? (() => Date.now()),
			...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
			clientId: "id",
			clientSecret: "secret",
			baseUrl: "http://test",
		},
	);
}

function mkApp(opts: MkAppOpts) {
	const registry = mkRegistry(opts);
	const app = new Hono();
	app.use(
		"*",
		sessionMiddleware({
			registry,
			secureCookies: false,
			...(opts.nowFn ? { nowFn: opts.nowFn } : {}),
		}),
	);
	app.get("/protected", (c) => {
		const user = c.get("user");
		return c.json({ user: user ?? null });
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
	const provider: SessionProvider = over.provider ?? "github";
	const payload: SessionPayload = {
		provider,
		login: "alice",
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
	it("redirects to /login when no session cookie", async () => {
		const app = mkApp({ authAllow: "github:user:alice" });
		const res = await app.request("/protected");
		expect(res.status).toBe(302);
		const loc = res.headers.get("location");
		expect(loc).toMatch(/^\/login\?returnTo=/);
	});

	it("passes through on fresh github session with allowed user", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 1000 });
		const app = mkApp({
			authAllow: "github:user:alice",
			nowFn: () => now,
		});
		const res = await app.request("/protected", {
			headers: { cookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { login: string } };
		expect(body.user.login).toBe("alice");
	});

	it("passes through on fresh local session", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({
			provider: "local",
			login: "dev",
			mail: "dev@dev.local",
			orgs: [],
			accessToken: "",
			resolvedAt: now - 1000,
		});
		const app = mkApp({ authAllow: "local:dev", nowFn: () => now });
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { login: string } };
		expect(body.user.login).toBe("dev");
	});

	it("refreshes stale github session and re-seals", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 60 * 60_000 });
		const fetchFn = fakeFetch({
			"/user": { body: { login: "alice", email: "alice@x" } },
			"/user/orgs": { body: [{ login: "acme" }] },
		});
		const app = mkApp({
			authAllow: "github:user:alice",
			fetchFn,
			nowFn: () => now,
		});
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(fetchFn).toHaveBeenCalled();
		const setCookies = res.headers.getSetCookie();
		const session = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
		expect(session).toBeDefined();
	});

	it("refreshes stale local session WITHOUT external call", async () => {
		const now = 1_700_000_000_000;
		const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
		const { cookie } = await freshCookie({
			provider: "local",
			login: "dev",
			mail: "dev@dev.local",
			orgs: [],
			accessToken: "",
			resolvedAt: now - 60 * 60_000,
		});
		const app = mkApp({
			authAllow: "local:dev",
			fetchFn,
			nowFn: () => now,
		});
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("fails closed when GitHub returns 5xx on refresh", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 60 * 60_000 });
		const fetchFn = fakeFetch({
			"/user": { body: {}, status: 500 },
			"/user/orgs": { body: [{ login: "acme" }] },
		});
		const app = mkApp({
			authAllow: "github:user:alice",
			fetchFn,
			nowFn: () => now,
		});
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/^\/login/);
	});

	it("redirects with flash when refresh finds user now outside allow-list", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ resolvedAt: now - 60 * 60_000 });
		const fetchFn = fakeFetch({
			"/user": { body: { login: "alice", email: null } },
			"/user/orgs": { body: [] }, // left acme
		});
		const app = mkApp({
			authAllow: "github:user:other,github:org:acme",
			fetchFn,
			nowFn: () => now,
		});
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/login");
		const setCookies = res.headers.getSetCookie();
		const flash = setCookies.find((c) => c.startsWith(`${FLASH_COOKIE}=`));
		expect(flash).toBeDefined();
		const flashValue = flash?.split(";")[0]?.split("=")[1] ?? "";
		await expect(unsealFlash(flashValue)).resolves.toEqual({
			kind: "denied",
			login: "alice",
		});
	});

	it("redirects on expired (hard TTL exceeded) session", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({ exp: now - 1 });
		const app = mkApp({
			authAllow: "github:user:alice",
			nowFn: () => now,
		});
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/^\/login/);
	});

	it("redirects on tampered cookie", async () => {
		const { cookie } = await freshCookie();
		const tampered = `${cookie.slice(0, -2)}XX`;
		const app = mkApp({ authAllow: "github:user:alice" });
		const res = await app.request("/protected", {
			headers: { cookie: tampered },
		});
		expect(res.status).toBe(302);
	});

	it("clears cookie and redirects when payload references unregistered provider", async () => {
		const now = 1_700_000_000_000;
		const { cookie } = await freshCookie({
			provider: "local",
			login: "dev",
			resolvedAt: now - 1000,
		});
		// Registry has only github — local session can't be refreshed
		const app = mkApp({
			authAllow: "github:user:alice",
			nowFn: () => now,
		});
		const res = await app.request("/protected", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/^\/login/);
		const setCookies = res.headers.getSetCookie();
		const sessionCleared = setCookies.find((c) =>
			c.startsWith(`${SESSION_COOKIE}=;`),
		);
		expect(sessionCleared).toBeDefined();
	});
});
