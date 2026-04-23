import { Hono } from "hono";
import { html } from "hono/html";
import { describe, expect, it } from "vitest";
import type {
	AuthProvider,
	ProviderRegistry,
} from "../auth/providers/index.js";
import type { UserContext } from "../auth/user-context.js";
import { apiAuthMiddleware } from "./auth.js";

function stubProvider(
	id: string,
	resolve: (req: Request) => Promise<UserContext | undefined>,
): AuthProvider {
	return {
		id,
		renderLoginSection: () => html``,
		mountAuthRoutes: () => {},
		resolveApiIdentity: resolve,
		refreshSession: () => Promise.resolve(undefined),
	};
}

function registry(...providers: AuthProvider[]): ProviderRegistry {
	const byId = new Map(providers.map((p) => [p.id, p]));
	return {
		providers,
		byId: (id) => byId.get(id),
	};
}

function createApp(reg: ProviderRegistry): Hono {
	const app = new Hono();
	app.use("*", apiAuthMiddleware({ registry: reg }));
	app.post("/workflows", (c) => c.text("ok"));
	return app;
}

const ALICE: UserContext = { name: "alice", mail: "a@x", orgs: ["acme"] };

describe("apiAuthMiddleware", () => {
	it("returns 401 when X-Auth-Provider header is missing", async () => {
		const reg = registry(stubProvider("github", () => Promise.resolve(ALICE)));
		const app = createApp(reg);
		const res = await app.request("/workflows", { method: "POST" });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 when X-Auth-Provider names an unknown provider", async () => {
		const reg = registry(stubProvider("github", () => Promise.resolve(ALICE)));
		const app = createApp(reg);
		const res = await app.request("/workflows", {
			method: "POST",
			headers: { "x-auth-provider": "oidc" },
		});
		expect(res.status).toBe(401);
	});

	it("dispatches to the named provider and sets user on success", async () => {
		const reg = registry(stubProvider("github", () => Promise.resolve(ALICE)));
		const app = new Hono();
		app.use("*", apiAuthMiddleware({ registry: reg }));
		app.post("/workflows", (c) => c.json({ user: c.get("user") }));
		const res = await app.request("/workflows", {
			method: "POST",
			headers: {
				"x-auth-provider": "github",
				authorization: "Bearer xyz",
			},
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ user: ALICE });
	});

	it("returns 401 when provider returns undefined", async () => {
		const reg = registry(
			stubProvider("github", () => Promise.resolve(undefined)),
		);
		const app = createApp(reg);
		const res = await app.request("/workflows", {
			method: "POST",
			headers: { "x-auth-provider": "github" },
		});
		expect(res.status).toBe(401);
	});

	it("returns identical 401 body across failure modes", async () => {
		const reg = registry(
			stubProvider("github", () => Promise.resolve(undefined)),
		);
		const app = createApp(reg);
		const a = await app.request("/workflows", { method: "POST" });
		const b = await app.request("/workflows", {
			method: "POST",
			headers: { "x-auth-provider": "oidc" },
		});
		const c = await app.request("/workflows", {
			method: "POST",
			headers: { "x-auth-provider": "github" },
		});
		expect(a.status).toBe(401);
		expect(b.status).toBe(401);
		expect(c.status).toBe(401);
		expect(await a.json()).toEqual({ error: "Unauthorized" });
		expect(await b.json()).toEqual({ error: "Unauthorized" });
		expect(await c.json()).toEqual({ error: "Unauthorized" });
	});

	it("does not consult other providers when the named one returns undefined", async () => {
		let secondCalled = false;
		const reg = registry(
			stubProvider("github", () => Promise.resolve(undefined)),
			stubProvider("local", () => {
				secondCalled = true;
				return Promise.resolve(ALICE);
			}),
		);
		const app = createApp(reg);
		const res = await app.request("/workflows", {
			method: "POST",
			headers: { "x-auth-provider": "github" },
		});
		expect(res.status).toBe(401);
		expect(secondCalled).toBe(false);
	});
});
