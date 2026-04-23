import { constants } from "node:http2";
import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import type { Middleware } from "../triggers/http.js";
import { createNotFoundHandler, type Pages } from "./content-negotiation.js";
import { createApp } from "./server.js";

const NOT_FOUND_HTML =
	"<!DOCTYPE html><html><body><span>Page not found (fixture)</span></body></html>";
const ERROR_HTML =
	"<!DOCTYPE html><html><body><span>Something went wrong (fixture)</span></body></html>";

function fixturePages() {
	return { pages: { notFound: NOT_FOUND_HTML, error: ERROR_HTML } };
}

function subApp(
	basePath: string,
	build: (app: Hono) => void,
	opts: { pages?: Pages } = {},
): Middleware {
	const app = new Hono().basePath(basePath);
	build(app);
	// Sub-apps install their own notFound handler because Hono sub-apps
	// mounted via `app.use(match, c => subApp.fetch(...))` always return a
	// response — unmatched paths never bubble up to the parent's notFound.
	// The shared factory keeps the Accept-branch logic consistent across
	// every sub-app in the runtime.
	app.notFound(createNotFoundHandler(opts.pages));
	return {
		match: `${basePath}/*`,
		handler: async (c) => app.fetch(c.req.raw),
	};
}

describe("createApp — plumbing", () => {
	it("mounts middleware in order", async () => {
		const order: string[] = [];
		const mwA: MiddlewareHandler = async (_c, next) => {
			order.push("A");
			await next();
		};
		const mwB: MiddlewareHandler = async (_c, next) => {
			order.push("B");
			await next();
		};

		const app = createApp(
			fixturePages(),
			{ match: "/test/*", handler: mwA },
			{ match: "/test/*", handler: mwB },
		);
		await app.request("/test/anything");

		expect(order).toEqual(["A", "B"]);
	});

	it("rejects bodies larger than the limit with 413 JSON", async () => {
		const passthrough: MiddlewareHandler = async (c) => c.body(null, 204);
		const app = createApp(fixturePages(), {
			match: "/upload",
			handler: passthrough,
		});

		const BYTES_PER_MIB = 1024 * 1024;
		const oversized = new Uint8Array(10 * BYTES_PER_MIB + 1);
		const res = await app.request("/upload", {
			method: "POST",
			body: oversized,
			headers: { "content-length": String(oversized.length) },
		});

		expect(res.status).toBe(constants.HTTP_STATUS_PAYLOAD_TOO_LARGE);
		expect(await res.json()).toEqual({ error: "payload_too_large" });
	});
});

describe("createApp — root redirect", () => {
	it("GET / returns 302 to /trigger", async () => {
		const app = createApp(fixturePages());
		const res = await app.request("/");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/trigger");
	});

	it("POST / is not redirected by the root handler", async () => {
		const app = createApp(fixturePages());
		const res = await app.request("/", { method: "POST" });
		// The root redirect is a GET handler only — POST / falls through to the
		// global notFound.
		expect(res.status).toBe(404);
	});
});

describe("createApp — global notFound", () => {
	it("browser request to unknown path returns HTML 404", async () => {
		const app = createApp(fixturePages());
		const res = await app.request("/nonexistent", {
			headers: { Accept: "text/html,*/*;q=0.8" },
		});
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(await res.text()).toBe(NOT_FOUND_HTML);
	});

	it("JSON client request to unknown path returns JSON 404", async () => {
		const app = createApp(fixturePages());
		const res = await app.request("/nonexistent", {
			headers: { Accept: "application/json" },
		});
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toMatch(/^application\/json/);
		expect(await res.json()).toEqual({ error: "Not Found" });
	});

	it("request without Accept header returns JSON 404", async () => {
		const app = createApp(fixturePages());
		const res = await app.request("/nonexistent");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not Found" });
	});

	it("Accept: */* returns JSON 404", async () => {
		const app = createApp(fixturePages());
		const res = await app.request("/nonexistent", {
			headers: { Accept: "*/*" },
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not Found" });
	});

	it("sub-app 404 returns HTML via the shared factory (HTML branch)", async () => {
		const app = createApp(
			fixturePages(),
			subApp(
				"/trigger",
				(s) => {
					s.get("/known", (c) => c.text("yes"));
				},
				fixturePages(),
			),
		);
		const res = await app.request("/trigger/nonexistent-page", {
			headers: { Accept: "text/html" },
		});
		expect(res.status).toBe(404);
		expect(await res.text()).toBe(NOT_FOUND_HTML);
	});

	it("sub-app /api 404 returns JSON for JSON clients via the shared factory", async () => {
		const app = createApp(
			fixturePages(),
			subApp(
				"/api",
				(s) => {
					s.get("/known", (c) => c.json({ ok: true }));
				},
				fixturePages(),
			),
		);
		const res = await app.request("/api/workflows/does-not-exist", {
			headers: { Accept: "application/json" },
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not Found" });
	});
});

describe("createApp — global onError", () => {
	it("thrown error with HTML Accept returns HTML 500", async () => {
		const app = createApp(fixturePages(), {
			match: "/boom",
			handler: () => {
				throw new Error("kaboom");
			},
		});
		const res = await app.request("/boom", {
			headers: { Accept: "text/html" },
		});
		expect(res.status).toBe(500);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(await res.text()).toBe(ERROR_HTML);
	});

	it("thrown error with JSON Accept returns JSON 500", async () => {
		const app = createApp(fixturePages(), {
			match: "/boom",
			handler: () => {
				throw new Error("kaboom");
			},
		});
		const res = await app.request("/boom", {
			headers: { Accept: "application/json" },
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "Internal Server Error" });
	});

	it("explicit c.json(..., 500) bypasses onError", async () => {
		const app = createApp(fixturePages(), {
			match: "/explicit",
			handler: async (c) => c.json({ error: "specific" }, 500),
		});
		const res = await app.request("/explicit", {
			headers: { Accept: "text/html" },
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "specific" });
	});
});
