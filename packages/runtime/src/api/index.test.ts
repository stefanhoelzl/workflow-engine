import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Auth } from "../auth/allowlist.js";
import type { Executor } from "../executor/index.js";
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

const stubExecutor: Executor = {
	invoke: vi.fn(async () => ({ ok: true as const, output: {} })),
};

function mountApi(auth: Auth, fetchFn?: typeof globalThis.fetch) {
	const registry = createWorkflowRegistry({ logger, executor: stubExecutor });
	const middleware = apiMiddleware({
		auth,
		registry,
		logger,
		...(fetchFn ? { fetchFn } : {}),
	});
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
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

			const res = await app.request("/api/does-not-exist", { method: "GET" });

			expect(res.status).toBe(404);
		});
	});

	describe("mode: restricted", () => {
		const restrictedAuth = (
			users: string[] = [],
			orgs: string[] = [],
		): Auth => ({
			mode: "restricted",
			users: new Set(users),
			orgs: new Set(orgs),
		});

		it("rejects requests without an Authorization header with 401", async () => {
			const app = mountApi(restrictedAuth(["stefan"]));

			const res = await app.request("/api/anything", { method: "POST" });

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		});

		it("rejects an unauthenticated upload with 401 — body never reaches the registry", async () => {
			const app = mountApi(restrictedAuth(["stefan"]));

			const res = await app.request("/api/workflows", {
				method: "POST",
				body: "not-a-tarball",
			});

			expect(res.status).toBe(401);
		});

		it("allows an org member via AUTH_ALLOW=github:org:acme", async () => {
			const fetchFn = githubFetch({ login: "bob", email: null }, [
				{ login: "acme" },
			]);
			const app = mountApi(restrictedAuth([], ["acme"]), fetchFn);

			const res = await app.request("/api/workflows/acme", {
				method: "POST",
				headers: { authorization: "Bearer valid-token" },
				body: new Uint8Array(),
			});

			// Unauthorized path would return 401; reaching the upload handler with
			// empty body yields 415 (unsupported media) or 422. Here we just
			// verify it gets past auth (not 401).
			expect(res.status).not.toBe(401);
		});

		it("forged X-Auth-Request-Groups cannot grant cross-tenant upload", async () => {
			const fetchFn = githubFetch({ login: "stefan", email: null }, []);
			const app = mountApi(restrictedAuth(["stefan"]), fetchFn);

			const res = await app.request("/api/workflows/victim-tenant", {
				method: "POST",
				headers: {
					authorization: "Bearer valid-token",
					"X-Auth-Request-User": "stefan",
					"X-Auth-Request-Groups": "victim-tenant",
				},
				body: new Uint8Array(),
			});

			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ error: "Not Found" });
		});
	});
});
