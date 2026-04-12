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
	child: vi.fn(),
};

function mountApi(githubAuth: GitHubAuth) {
	const registry = createWorkflowRegistry({ logger });
	const middleware = apiMiddleware({ registry, githubAuth });
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
	return app;
}

describe("apiMiddleware", () => {
	describe("mode: disabled", () => {
		it("returns 401 for every request, even with a valid Bearer header", async () => {
			const app = mountApi({ mode: "disabled" });

			const res = await app.request("/api/workflows", {
				method: "POST",
				headers: { authorization: "Bearer some-token" },
			});

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		});

		it("returns 401 for unknown /api paths too", async () => {
			const app = mountApi({ mode: "disabled" });

			const res = await app.request("/api/does-not-exist", { method: "GET" });

			expect(res.status).toBe(401);
		});
	});

	describe("mode: open", () => {
		it("reaches the upload handler without authentication", async () => {
			const app = mountApi({ mode: "open" });

			const res = await app.request("/api/workflows", {
				method: "POST",
				body: "not a gzip",
			});

			expect(res.status).toBe(415);
		});
	});

	describe("mode: restricted", () => {
		it("rejects requests without an Authorization header with 401", async () => {
			const app = mountApi({ mode: "restricted", users: ["stefan"] });

			const res = await app.request("/api/workflows", { method: "POST" });

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		});
	});
});
