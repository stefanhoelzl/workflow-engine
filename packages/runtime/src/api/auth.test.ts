import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { githubAuthMiddleware } from "./auth.js";

function createApp(githubUsers: string[], fetchFn: typeof globalThis.fetch) {
	const app = new Hono();
	app.use("/api/*", githubAuthMiddleware({ githubUsers, fetchFn }));
	app.post("/api/workflows", (c) => c.text("ok"));
	return app;
}

describe("githubAuthMiddleware", () => {
	it("allows request with valid token and matching user", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ login: "stefan" }), { status: 200 }),
			);
		const app = createApp(["stefan"], fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer valid-token" },
		});

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
		expect(fetchFn).toHaveBeenCalledWith(
			"https://api.github.com/user",
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: "Bearer valid-token",
				}),
			}),
		);
	});

	it("allows request when login is in a multi-user allow-list", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ login: "bob" }), { status: 200 }),
			);
		const app = createApp(["alice", "bob"], fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer valid-token" },
		});

		expect(res.status).toBe(200);
	});

	it("returns 401 when Authorization header is missing", async () => {
		const fetchFn = vi.fn();
		const app = createApp(["stefan"], fetchFn);

		const res = await app.request("/api/workflows", { method: "POST" });

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("returns 401 when token is invalid (GitHub returns error)", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: "Bad credentials" }), {
				status: 401,
			}),
		);
		const app = createApp(["stefan"], fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer bad-token" },
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 when GitHub API is unreachable", async () => {
		const fetchFn = vi.fn().mockRejectedValue(new Error("Network error"));
		const app = createApp(["stefan"], fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer some-token" },
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 when token is valid but login is not on allow-list", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ login: "other-user" }), { status: 200 }),
			);
		const app = createApp(["stefan"], fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer valid-token" },
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 for non-Bearer auth scheme", async () => {
		const fetchFn = vi.fn();
		const app = createApp(["stefan"], fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Basic dXNlcjpwYXNz" },
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("returns identical 401 response for wrong-user and missing-header cases", async () => {
		const missingHeaderApp = createApp(["stefan"], vi.fn());
		const wrongUserFetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ login: "other-user" }), { status: 200 }),
			);
		const wrongUserApp = createApp(["stefan"], wrongUserFetch);

		const missingRes = await missingHeaderApp.request("/api/workflows", {
			method: "POST",
		});
		const wrongRes = await wrongUserApp.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer valid-token" },
		});

		expect(wrongRes.status).toBe(missingRes.status);
		expect(wrongRes.headers.get("content-type")).toBe(
			missingRes.headers.get("content-type"),
		);
		expect(await wrongRes.text()).toBe(await missingRes.text());
	});
});
