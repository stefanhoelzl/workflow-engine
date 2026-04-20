import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { bearerUserMiddleware } from "./bearer-user.js";
import type { UserContext } from "./user-context.js";

function createApp(fetchFn?: typeof globalThis.fetch) {
	const app = new Hono();
	app.use("*", bearerUserMiddleware(fetchFn ? { fetchFn } : {}));
	app.get("/probe", (c) => {
		const user = c.get("user") as UserContext | undefined;
		return c.json(user ?? null);
	});
	return app;
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function githubFetch(
	user: { login: string; email: string | null } | null,
	orgs: Array<{ login: string }> | null,
) {
	const routes = new Map<string, Response>([
		["/user/orgs", orgs ? jsonResponse(orgs) : jsonResponse({}, 403)],
		["/user", user ? jsonResponse(user) : jsonResponse({}, 401)],
	]);
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = input.toString();
		for (const [suffix, response] of routes) {
			if (url.endsWith(suffix)) {
				return response.clone();
			}
		}
		return jsonResponse({}, 404);
	});
}

describe("bearerUserMiddleware (Bearer token)", () => {
	it("fetches user and orgs from GitHub", async () => {
		const fetchFn = githubFetch({ login: "alice", email: "alice@acme.test" }, [
			{ login: "acme" },
			{ login: "contoso" },
		]);
		const app = createApp(fetchFn);

		const res = await app.request("/probe", {
			headers: { authorization: "Bearer valid-token" },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "alice",
			mail: "alice@acme.test",
			orgs: ["acme", "contoso"],
		});
	});

	it("falls back to empty orgs when GitHub scopes are missing", async () => {
		const fetchFn = githubFetch({ login: "alice", email: null }, null);
		const app = createApp(fetchFn);

		const res = await app.request("/probe", {
			headers: { authorization: "Bearer limited-token" },
		});

		expect(await res.json()).toEqual({
			name: "alice",
			mail: "",
			orgs: [],
		});
	});

	it("does not set a user when /user returns an error", async () => {
		const fetchFn = githubFetch(null, null);
		const app = createApp(fetchFn);

		const res = await app.request("/probe", {
			headers: { authorization: "Bearer bad-token" },
		});

		expect(await res.json()).toBeNull();
	});

	it("does not set a user when GitHub is unreachable", async () => {
		const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
		const app = createApp(fetchFn);

		const res = await app.request("/probe", {
			headers: { authorization: "Bearer any-token" },
		});

		expect(await res.json()).toBeNull();
	});

	it("does not hit GitHub for non-Bearer auth schemes", async () => {
		const fetchFn = vi.fn();
		const app = createApp(fetchFn);

		await app.request("/probe", {
			headers: { authorization: "Basic dXNlcjpwYXNz" },
		});

		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("bearerUserMiddleware (forward-auth headers ignored)", () => {
	it("ignores forged X-Auth-Request-* headers; orgs come from GitHub", async () => {
		const fetchFn = githubFetch({ login: "alice", email: "alice@acme.test" }, [
			{ login: "acme" },
		]);
		const app = createApp(fetchFn);

		const res = await app.request("/probe", {
			headers: {
				authorization: "Bearer valid-token",
				"X-Auth-Request-User": "attacker",
				"X-Auth-Request-Email": "attacker@evil.test",
				"X-Auth-Request-Groups": "victim-tenant,another-victim",
			},
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "alice",
			mail: "alice@acme.test",
			orgs: ["acme"],
		});
	});

	it("leaves user unset when only X-Auth-Request-User is present (no Bearer)", async () => {
		const fetchFn = vi.fn();
		const app = createApp(fetchFn);

		const res = await app.request("/probe", {
			headers: {
				"X-Auth-Request-User": "attacker",
				"X-Auth-Request-Groups": "victim-tenant",
			},
		});

		expect(await res.json()).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("bearerUserMiddleware (no auth context)", () => {
	it("leaves user unset when no headers or token are present", async () => {
		const fetchFn = vi.fn();
		const app = createApp(fetchFn);

		const res = await app.request("/probe");

		expect(await res.json()).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
