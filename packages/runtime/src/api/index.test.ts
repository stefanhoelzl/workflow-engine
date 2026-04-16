import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { GitHubAuth } from "../config.js";
import { createWorkflowRegistry } from "../workflow-registry.js";
import { apiMiddleware } from "./index.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => logger),
};

function mountApi(githubAuth: GitHubAuth) {
	const registry = createWorkflowRegistry({ logger });
	const middleware = apiMiddleware({ githubAuth, registry, logger });
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
	return app;
}

describe("apiMiddleware", () => {
	describe("mode: disabled", () => {
		it("returns 401 for every /api/* request, even with a valid Bearer header", async () => {
			const app = mountApi({ mode: "disabled" });

			const res = await app.request("/api/anything", {
				method: "POST",
				headers: { authorization: "Bearer some-token" },
			});

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		});

		it("returns 401 for GET paths too", async () => {
			const app = mountApi({ mode: "disabled" });

			const res = await app.request("/api/does-not-exist", { method: "GET" });

			expect(res.status).toBe(401);
		});
	});

	describe("mode: open", () => {
		it("reaches the Hono /api/* router without authentication", async () => {
			const app = mountApi({ mode: "open" });

			// No routes are registered at /api/does-not-exist; Hono returns 404.
			// What matters for this test is that the auth layer did not
			// short-circuit with 401.
			const res = await app.request("/api/does-not-exist", { method: "GET" });

			expect(res.status).toBe(404);
		});
	});

	describe("mode: restricted", () => {
		it("rejects requests without an Authorization header with 401", async () => {
			const app = mountApi({ mode: "restricted", users: ["stefan"] });

			const res = await app.request("/api/anything", { method: "POST" });

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		});

		it("rejects an unauthenticated upload with 401 — body never reaches the registry", async () => {
			const app = mountApi({ mode: "restricted", users: ["stefan"] });

			const res = await app.request("/api/workflows", {
				method: "POST",
				body: "not-a-tarball",
			});

			expect(res.status).toBe(401);
		});
	});
});
