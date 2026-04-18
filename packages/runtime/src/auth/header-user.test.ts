import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { headerUserMiddleware } from "./header-user.js";
import type { UserContext } from "./user-context.js";

function createApp() {
	const app = new Hono();
	app.use("*", headerUserMiddleware());
	app.get("/probe", (c) => {
		const user = c.get("user") as UserContext | undefined;
		return c.json(user ?? null);
	});
	return app;
}

describe("headerUserMiddleware (forward-auth headers)", () => {
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
});

describe("headerUserMiddleware (Bearer ignored)", () => {
	it("does not authenticate via Authorization: Bearer alone", async () => {
		const app = createApp();

		const res = await app.request("/probe", {
			headers: { authorization: "Bearer some-token" },
		});

		expect(await res.json()).toBeNull();
	});
});

describe("headerUserMiddleware (no auth context)", () => {
	it("leaves user unset when no headers are present", async () => {
		const app = createApp();

		const res = await app.request("/probe");

		expect(await res.json()).toBeNull();
	});
});
