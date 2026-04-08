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
});
