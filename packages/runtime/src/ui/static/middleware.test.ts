import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { staticMiddleware } from "./middleware.js";

function mountApp() {
	const app = new Hono();
	const mw = staticMiddleware();
	app.use(mw.match, mw.handler);
	return app;
}

describe("staticMiddleware", () => {
	it("does NOT serve 404.html (rendered per-request via JSX, no static file)", async () => {
		const app = mountApp();
		const res = await app.request("/static/404.html");
		expect(res.status).toBe(404);
	});

	it("does NOT serve error.html (rendered per-request via JSX, no static file)", async () => {
		const app = mountApp();
		const res = await app.request("/static/error.html");
		expect(res.status).toBe(404);
	});

	it("serves workflow-engine.css with text/css content-type", async () => {
		const app = mountApp();
		const res = await app.request("/static/workflow-engine.css");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/css");
	});

	it("returns 404 for unknown files", async () => {
		const app = mountApp();
		const res = await app.request("/static/nonexistent.js");
		expect(res.status).toBe(404);
	});

	it("does not serve error.css (merged into workflow-engine.css)", async () => {
		const app = mountApp();
		const res = await app.request("/static/error.css");
		expect(res.status).toBe(404);
	});
});
