import { constants } from "node:http2";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
	HttpTriggerRegistry,
	httpTriggerMiddleware,
	type OnTriggerCallback,
} from "./http.js";

describe("HttpTriggerRegistry", () => {
	it("returns a registered trigger on matching path and method", () => {
		const registry = new HttpTriggerRegistry();
		const definition = {
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		};
		registry.register(definition);

		expect(registry.lookup("order", "POST")).toBe(definition);
	});

	it("returns null when no trigger matches", () => {
		const registry = new HttpTriggerRegistry();

		expect(registry.lookup("payment", "POST")).toBeNull();
	});

	it("returns null when method does not match", () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});

		expect(registry.lookup("order", "GET")).toBeNull();
	});
});

function createApp(
	registry: HttpTriggerRegistry,
	onTrigger: OnTriggerCallback,
) {
	const app = new Hono();
	const { match, handler } = httpTriggerMiddleware(registry, onTrigger);
	app.use(match, handler);
	return app;
}

describe("httpTriggerMiddleware — matching", () => {
	it("invokes callback and returns configured response for matching request", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const onTrigger = vi.fn();
		const app = createApp(registry, onTrigger);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ item: "widget" }),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_ACCEPTED);
		expect(await res.json()).toEqual({ accepted: true });
		expect(onTrigger).toHaveBeenCalledWith(
			expect.objectContaining({ path: "order", method: "POST" }),
			{ item: "widget" },
		);
	});
});

describe("httpTriggerMiddleware — pass-through", () => {
	it("passes through when no trigger matches", async () => {
		const registry = new HttpTriggerRegistry();
		const onTrigger = vi.fn();
		const app = createApp(registry, onTrigger);

		const res = await app.request("/webhooks/unknown", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
		expect(onTrigger).not.toHaveBeenCalled();
	});

	it("does not handle requests outside /webhooks/", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const onTrigger = vi.fn();
		const app = createApp(registry, onTrigger);

		const res = await app.request("/api/health", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
		expect(onTrigger).not.toHaveBeenCalled();
	});
});

describe("httpTriggerMiddleware — error handling", () => {
	it("returns 400 for non-JSON request body", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const onTrigger = vi.fn();
		const app = createApp(registry, onTrigger);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: "not json",
		});

		expect(res.status).toBe(constants.HTTP_STATUS_BAD_REQUEST);
		expect(onTrigger).not.toHaveBeenCalled();
	});
});
