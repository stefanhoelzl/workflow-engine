import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { UserContext } from "./user.js";
import { userMiddleware } from "./user.js";

function createApp(fetchFn?: typeof globalThis.fetch) {
	const app = new Hono();
	app.use("*", userMiddleware(fetchFn ? { fetchFn } : {}));
	app.get("/probe", (c) => {
		const user = c.get("user") as UserContext | undefined;
		return c.json(user ?? null);
	});
	return app;
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

describe("userMiddleware (forward-auth headers)", () => {
	it("builds user from X-Auth-Request-* headers with orgs and teams", async () => {
		const app = createApp();

		const res = await app.request("/probe", {
			headers: {
				"X-Auth-Request-User": "alice",
				"X-Auth-Request-Email": "alice@acme.test",
				"X-Auth-Request-Groups": "acme,contoso,acme:engineering,acme:ops",
			},
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "alice",
			mail: "alice@acme.test",
			orgs: ["acme", "contoso"],
			teams: ["acme:engineering", "acme:ops"],
		});
	});

	it("handles an empty groups header", async () => {
		const app = createApp();

		const res = await app.request("/probe", {
			headers: {
				"X-Auth-Request-User": "bob",
				"X-Auth-Request-Email": "bob@acme.test",
				"X-Auth-Request-Groups": "",
			},
		});

		expect(await res.json()).toEqual({
			name: "bob",
			mail: "bob@acme.test",
			orgs: [],
			teams: [],
		});
	});

	it("handles org-only membership (no teams)", async () => {
		const app = createApp();

		const res = await app.request("/probe", {
			headers: {
				"X-Auth-Request-User": "carol",
				"X-Auth-Request-Groups": "acme",
			},
		});

		expect(await res.json()).toEqual({
			name: "carol",
			mail: "",
			orgs: ["acme"],
			teams: [],
		});
	});

	it("ignores Authorization header when forward-auth header is present", async () => {
		const fetchFn = vi.fn();
		const app = createApp(fetchFn);

		await app.request("/probe", {
			headers: {
				"X-Auth-Request-User": "alice",
				authorization: "Bearer some-token",
			},
		});

		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("userMiddleware (Bearer token)", () => {
	function githubFetch(
		user: { login: string; email: string | null } | null,
		orgs: Array<{ login: string }> | null,
		teams: Array<{ slug: string; organization: { login: string } }> | null,
	) {
		const routes = new Map<string, Response>([
			["/user/orgs", orgs ? jsonResponse(orgs) : jsonResponse({}, 403)],
			["/user/teams", teams ? jsonResponse(teams) : jsonResponse({}, 403)],
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

	it("fetches user, orgs, and teams from GitHub", async () => {
		const fetchFn = githubFetch(
			{ login: "alice", email: "alice@acme.test" },
			[{ login: "acme" }, { login: "contoso" }],
			[
				{ slug: "engineering", organization: { login: "acme" } },
				{ slug: "ops", organization: { login: "acme" } },
			],
		);
		const app = createApp(fetchFn);

		const res = await app.request("/probe", {
			headers: { authorization: "Bearer valid-token" },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			name: "alice",
			mail: "alice@acme.test",
			orgs: ["acme", "contoso"],
			teams: ["acme:engineering", "acme:ops"],
		});
	});

	it("falls back to empty orgs/teams when GitHub scopes are missing", async () => {
		const fetchFn = githubFetch({ login: "alice", email: null }, null, null);
		const app = createApp(fetchFn);

		const res = await app.request("/probe", {
			headers: { authorization: "Bearer limited-token" },
		});

		expect(await res.json()).toEqual({
			name: "alice",
			mail: "",
			orgs: [],
			teams: [],
		});
	});

	it("does not set a user when /user returns an error", async () => {
		const fetchFn = githubFetch(null, null, null);
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

describe("userMiddleware (no auth context)", () => {
	it("leaves user unset when no headers or token are present", async () => {
		const fetchFn = vi.fn();
		const app = createApp(fetchFn);

		const res = await app.request("/probe");

		expect(await res.json()).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
