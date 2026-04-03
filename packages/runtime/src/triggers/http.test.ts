import { constants } from "node:http2";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpTriggerContext } from "../context/index.js";
import {
	HttpTriggerRegistry,
	httpTriggerMiddleware,
	type TriggerContextFactory,
} from "./http.js";

describe("HttpTriggerRegistry", () => {
	it("returns a registered trigger on matching path and method", () => {
		const registry = new HttpTriggerRegistry();
		const definition = {
			path: "order",
			method: "POST",
			event: "order.received",
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
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});

		expect(registry.lookup("order", "GET")).toBeNull();
	});
});

function createApp(
	registry: HttpTriggerRegistry,
	createContext: TriggerContextFactory,
) {
	const app = new Hono();
	const { match, handler } = httpTriggerMiddleware(registry, createContext);
	app.use(match, handler);
	return app;
}

function stubTriggerContextFactory(): {
	factory: TriggerContextFactory;
	emitSpy: ReturnType<typeof vi.fn>;
} {
	const emitSpy = vi.fn().mockResolvedValue(undefined);
	const factory: TriggerContextFactory = (body, definition) =>
		new HttpTriggerContext(body, definition, emitSpy);
	return { factory, emitSpy };
}

describe("httpTriggerMiddleware — matching", () => {
	it("creates context and calls emit for matching request", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const { factory, emitSpy } = stubTriggerContextFactory();
		const app = createApp(registry, factory);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ item: "widget" }),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_ACCEPTED);
		expect(await res.json()).toEqual({ accepted: true });
		expect(emitSpy).toHaveBeenCalledWith(
			"order.received",
			{ item: "widget" },
			undefined,
		);
	});
});

describe("httpTriggerMiddleware — pass-through", () => {
	it("passes through when no trigger matches", async () => {
		const registry = new HttpTriggerRegistry();
		const { factory, emitSpy } = stubTriggerContextFactory();
		const app = createApp(registry, factory);

		const res = await app.request("/webhooks/unknown", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
		expect(emitSpy).not.toHaveBeenCalled();
	});

	it("does not handle requests outside /webhooks/", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const { factory, emitSpy } = stubTriggerContextFactory();
		const app = createApp(registry, factory);

		const res = await app.request("/api/health", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
		expect(emitSpy).not.toHaveBeenCalled();
	});
});

describe("httpTriggerMiddleware — error handling", () => {
	it("returns 400 for non-JSON request body", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const { factory, emitSpy } = stubTriggerContextFactory();
		const app = createApp(registry, factory);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: "not json",
		});

		expect(res.status).toBe(constants.HTTP_STATUS_BAD_REQUEST);
		expect(emitSpy).not.toHaveBeenCalled();
	});
});
