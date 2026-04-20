import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Auth } from "../auth/allowlist.js";
import type { UserContext } from "../auth/user-context.js";
import { authorizeMiddleware, rejectAllMiddleware } from "./auth.js";

function createApp(auth: Extract<Auth, { mode: "restricted" }>) {
	const app = new Hono();
	app.use("*", authorizeMiddleware({ auth }));
	app.post("/api/workflows", (c) => c.text("ok"));
	return app;
}

function withUser(user: UserContext) {
	return async (c: any, next: () => Promise<void>) => {
		c.set("user", user);
		await next();
	};
}

describe("authorizeMiddleware", () => {
	it("allows when login matches users allow-list", async () => {
		const app = new Hono();
		app.use("*", withUser({ name: "stefan", mail: "", orgs: [] }));
		app.use(
			"*",
			authorizeMiddleware({
				auth: {
					mode: "restricted",
					users: new Set(["stefan"]),
					orgs: new Set(),
				},
			}),
		);
		app.post("/api/workflows", (c) => c.text("ok"));

		const res = await app.request("/api/workflows", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("allows when any org matches orgs allow-list", async () => {
		const app = new Hono();
		app.use("*", withUser({ name: "bob", mail: "", orgs: ["acme"] }));
		app.use(
			"*",
			authorizeMiddleware({
				auth: {
					mode: "restricted",
					users: new Set(),
					orgs: new Set(["acme"]),
				},
			}),
		);
		app.post("/api/workflows", (c) => c.text("ok"));

		const res = await app.request("/api/workflows", { method: "POST" });
		expect(res.status).toBe(200);
	});

	it("returns 401 when user context is absent", async () => {
		const app = createApp({
			mode: "restricted",
			users: new Set(["stefan"]),
			orgs: new Set(),
		});
		const res = await app.request("/api/workflows", { method: "POST" });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 when login not on allow-list and no org match", async () => {
		const app = new Hono();
		app.use("*", withUser({ name: "eve", mail: "", orgs: ["elsewhere"] }));
		app.use(
			"*",
			authorizeMiddleware({
				auth: {
					mode: "restricted",
					users: new Set(["stefan"]),
					orgs: new Set(["acme"]),
				},
			}),
		);
		app.post("/api/workflows", (c) => c.text("ok"));

		const res = await app.request("/api/workflows", { method: "POST" });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns identical 401 responses for absent user vs allow-list miss", async () => {
		const absentApp = createApp({
			mode: "restricted",
			users: new Set(["stefan"]),
			orgs: new Set(),
		});
		const missApp = new Hono();
		missApp.use("*", withUser({ name: "other", mail: "", orgs: [] }));
		missApp.use(
			"*",
			authorizeMiddleware({
				auth: {
					mode: "restricted",
					users: new Set(["stefan"]),
					orgs: new Set(),
				},
			}),
		);
		missApp.post("/api/workflows", (c) => c.text("ok"));

		const absent = await absentApp.request("/api/workflows", {
			method: "POST",
		});
		const miss = await missApp.request("/api/workflows", { method: "POST" });
		expect(absent.status).toBe(miss.status);
		expect(await absent.text()).toBe(await miss.text());
	});
});

describe("rejectAllMiddleware", () => {
	it("responds 401 to every request", async () => {
		const app = new Hono();
		app.use("*", rejectAllMiddleware());
		app.post("/api/anything", (c) => c.text("never"));
		const res = await app.request("/api/anything", { method: "POST" });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});
});
