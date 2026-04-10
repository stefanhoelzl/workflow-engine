import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { githubAuthMiddleware } from "./auth.js";

function createApp(githubUser: string, fetchFn: typeof globalThis.fetch) {
	const app = new Hono();
	app.use("/api/*", githubAuthMiddleware({ githubUser, fetchFn }));
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
		const app = createApp("stefan", fetchFn);

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

	it("returns 401 when Authorization header is missing", async () => {
		const fetchFn = vi.fn();
		const app = createApp("stefan", fetchFn);

		const res = await app.request("/api/workflows", { method: "POST" });

		expect(res.status).toBe(401);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("returns 401 when token is invalid (GitHub returns error)", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: "Bad credentials" }), {
				status: 401,
			}),
		);
		const app = createApp("stefan", fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer bad-token" },
		});

		expect(res.status).toBe(401);
	});

	it("returns 401 when GitHub API is unreachable", async () => {
		const fetchFn = vi.fn().mockRejectedValue(new Error("Network error"));
		const app = createApp("stefan", fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer some-token" },
		});

		expect(res.status).toBe(401);
	});

	it("returns 403 when token is valid but user does not match", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ login: "other-user" }), { status: 200 }),
			);
		const app = createApp("stefan", fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Bearer valid-token" },
		});

		expect(res.status).toBe(403);
	});

	it("returns 401 for non-Bearer auth scheme", async () => {
		const fetchFn = vi.fn();
		const app = createApp("stefan", fetchFn);

		const res = await app.request("/api/workflows", {
			method: "POST",
			headers: { authorization: "Basic dXNlcjpwYXNz" },
		});

		expect(res.status).toBe(401);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
