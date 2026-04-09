import { constants } from "node:http2";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpTriggerContext } from "../context/index.js";
import { PayloadValidationError } from "../context/errors.js";
import {
	HttpTriggerRegistry,
	httpTriggerMiddleware,
	type TriggerContextFactory,
} from "./http.js";

describe("HttpTriggerRegistry", () => {
	it("returns a registered trigger on matching path and method", () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "orders",
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202, body: { accepted: true } },
		});

		expect(registry.lookup("order", "POST")).toEqual({
			name: "orders",
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202, body: { accepted: true } },
		});
	});

	it("returns null when no trigger matches", () => {
		const registry = new HttpTriggerRegistry();

		expect(registry.lookup("payment", "POST")).toBeNull();
	});

	it("returns null when method does not match", () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "orders",
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
			name: "orders",
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
			name: "orders",
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
			name: "orders",
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

	it("returns 422 with structured body when payload validation fails", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "orders",
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const emitSpy = vi.fn().mockRejectedValue(
			new PayloadValidationError("order.received", [
				{ path: "orderId", message: "Expected string, received number" },
			]),
		);
		const factory: TriggerContextFactory = (body, definition) =>
			new HttpTriggerContext(body, definition, emitSpy);
		const app = createApp(registry, factory);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: 123 }),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_UNPROCESSABLE_ENTITY);
		expect(await res.json()).toEqual({
			error: "payload_validation_failed",
			event: "order.received",
			issues: [{ path: "orderId", message: "Expected string, received number" }],
		});
	});

	it("returns configured response when payload is valid", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "orders",
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const { factory } = stubTriggerContextFactory();
		const app = createApp(registry, factory);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: "abc" }),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_ACCEPTED);
		expect(await res.json()).toEqual({ accepted: true });
	});
});
