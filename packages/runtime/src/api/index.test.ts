import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { githubProviderFactory } from "../auth/providers/github.js";
import {
	buildRegistry,
	type ProviderRegistry,
} from "../auth/providers/index.js";
import { localProviderFactory } from "../auth/providers/local.js";
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

interface MountOpts {
	authAllow: string;
	fetchFn?: typeof globalThis.fetch;
}

function mountApi(opts: MountOpts) {
	const factories = [githubProviderFactory, localProviderFactory];
	const authRegistry: ProviderRegistry = buildRegistry(
		opts.authAllow,
		factories,
		{
			secureCookies: false,
			nowFn: () => Date.now(),
			...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
			clientId: "id",
			clientSecret: "secret",
			baseUrl: "http://test",
		},
	);
	const registry = createWorkflowRegistry({ logger, executor: stubExecutor });
	const middleware = apiMiddleware({
		authRegistry,
		registry,
		logger,
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
	describe("empty registry", () => {
		it("returns 401 for every /api/* request", async () => {
			const app = mountApi({ authAllow: "" });

			const res = await app.request("/api/anything", {
				method: "POST",
				headers: {
					"x-auth-provider": "github",
					authorization: "Bearer some-token",
				},
			});

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		});

		it("returns 401 for GET paths too", async () => {
			const app = mountApi({ authAllow: "" });
			const res = await app.request("/api/does-not-exist", { method: "GET" });
			expect(res.status).toBe(401);
		});
	});

	describe("github provider", () => {
		it("rejects requests without X-Auth-Provider with 401", async () => {
			const app = mountApi({ authAllow: "github:user:stefan" });
			const res = await app.request("/api/anything", { method: "POST" });
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		});

		it("rejects unauthenticated upload with 401 — body never reaches the registry", async () => {
			const app = mountApi({ authAllow: "github:user:stefan" });
			const res = await app.request("/api/workflows/stefan", {
				method: "POST",
				body: "not-a-tarball",
			});
			expect(res.status).toBe(401);
		});

		it("allows an org member via github:org:acme", async () => {
			const fetchFn = githubFetch({ login: "bob", email: null }, [
				{ login: "acme" },
			]);
			const app = mountApi({ authAllow: "github:org:acme", fetchFn });

			const res = await app.request("/api/workflows/acme", {
				method: "POST",
				headers: {
					"x-auth-provider": "github",
					authorization: "Bearer valid-token",
				},
				body: new Uint8Array(),
			});

			expect(res.status).not.toBe(401);
		});

		it("forged X-Auth-Request-Groups cannot grant cross-tenant upload", async () => {
			const fetchFn = githubFetch({ login: "stefan", email: null }, []);
			const app = mountApi({ authAllow: "github:user:stefan", fetchFn });

			const res = await app.request("/api/workflows/victim-tenant", {
				method: "POST",
				headers: {
					"x-auth-provider": "github",
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

	describe("local provider", () => {
		it("authorizes via Authorization: User <name>", async () => {
			const app = mountApi({ authAllow: "local:dev" });
			const res = await app.request("/api/workflows/dev", {
				method: "POST",
				headers: {
					"x-auth-provider": "local",
					authorization: "User dev",
				},
				body: new Uint8Array(),
			});
			expect(res.status).not.toBe(401);
		});

		it("rejects unknown local user with 401", async () => {
			const app = mountApi({ authAllow: "local:dev" });
			const res = await app.request("/api/workflows/dev", {
				method: "POST",
				headers: {
					"x-auth-provider": "local",
					authorization: "User mallory",
				},
				body: new Uint8Array(),
			});
			expect(res.status).toBe(401);
		});

		it("local user denied access to another tenant with 404", async () => {
			const app = mountApi({ authAllow: "local:dev" });
			const res = await app.request("/api/workflows/other", {
				method: "POST",
				headers: {
					"x-auth-provider": "local",
					authorization: "User dev",
				},
				body: new Uint8Array(),
			});
			expect(res.status).toBe(404);
		});
	});
});
