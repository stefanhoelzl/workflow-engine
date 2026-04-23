import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireTenantMember } from "./tenant-mw.js";
import type { UserContext } from "./user-context.js";

interface AppOptions {
	readonly user?: UserContext;
}

function mkApp(options: AppOptions = {}) {
	const app = new Hono();
	app.use("/workflows/:tenant", async (c, next) => {
		if (options.user) {
			c.set("user", options.user);
		}
		await next();
	});
	app.use("/workflows/:tenant", requireTenantMember());
	app.post("/workflows/:tenant", (c) =>
		c.json({ ok: true, tenant: c.req.param("tenant") }),
	);
	app.notFound((c) => c.json({ error: "Not Found" }, 404));
	return app;
}

async function post(
	app: Hono,
	path: string,
): Promise<{ status: number; body: unknown }> {
	const res = await app.request(path, { method: "POST" });
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

const alice: UserContext = { name: "alice", mail: "", orgs: ["acme"] };

describe("requireTenantMember", () => {
	it("passes through when user is a member (org)", async () => {
		const app = mkApp({ user: alice });
		const { status, body } = await post(app, "/workflows/acme");
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, tenant: "acme" });
	});

	it("passes through when tenant equals user.name (personal namespace)", async () => {
		const app = mkApp({ user: alice });
		const { status, body } = await post(app, "/workflows/alice");
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, tenant: "alice" });
	});

	it("returns JSON 404 when user is not a member of tenant", async () => {
		const app = mkApp({ user: alice });
		const { status, body } = await post(app, "/workflows/victim");
		expect(status).toBe(404);
		expect(body).toEqual({ error: "Not Found" });
	});

	it("returns JSON 404 for invalid tenant identifier", async () => {
		const app = mkApp({ user: alice });
		const { status, body } = await post(app, "/workflows/..");
		expect(status).toBe(404);
		expect(body).toEqual({ error: "Not Found" });
	});

	it("returns JSON 404 when user is missing", async () => {
		const app = mkApp();
		const { status, body } = await post(app, "/workflows/acme");
		expect(status).toBe(404);
		expect(body).toEqual({ error: "Not Found" });
	});

	it("rejects regex-invalid tenant even when it matches a user org literally", async () => {
		const weird: UserContext = {
			name: "alice",
			mail: "",
			orgs: ["bad:group"],
		};
		const app = mkApp({ user: weird });
		const { status } = await post(app, "/workflows/bad:group");
		expect(status).toBe(404);
	});
});
