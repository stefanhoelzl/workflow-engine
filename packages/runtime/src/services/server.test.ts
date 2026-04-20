import { constants } from "node:http2";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "./server.js";

describe("createApp", () => {
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
			{ match: "/test/*", handler: mwA },
			{ match: "/test/*", handler: mwB },
		);
		await app.request("/test/anything");

		expect(order).toEqual(["A", "B"]);
	});

	it("returns 404 for unmatched routes", async () => {
		const app = createApp();

		const res = await app.request("/nonexistent", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
	});

	it("rejects bodies larger than the limit with 413 JSON", async () => {
		const passthrough: MiddlewareHandler = async (c) => c.body(null, 204);
		const app = createApp({ match: "/upload", handler: passthrough });

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
