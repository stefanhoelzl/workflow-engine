import { constants } from "node:http2";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { PayloadValidationError } from "../context/errors.js";
import type { EventSource } from "../event-source.js";
import type { RuntimeEvent } from "../event-bus/index.js";
import {
	HttpTriggerRegistry,
	httpTriggerMiddleware,
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

function stubEventSource(): { source: EventSource; createSpy: ReturnType<typeof vi.fn> } {
	const createSpy = vi.fn().mockResolvedValue({
		id: "evt_test",
		type: "order.received",
		state: "pending",
	} as RuntimeEvent);
	const source = {
		create: createSpy,
		derive: vi.fn(),
		fork: vi.fn(),
		transition: vi.fn(),
	} as unknown as EventSource;
	return { source, createSpy };
}

function createApp(registry: HttpTriggerRegistry, source: EventSource) {
	const app = new Hono();
	const { match, handler } = httpTriggerMiddleware(registry, source);
	app.use(match, handler);
	return app;
}

describe("httpTriggerMiddleware — matching", () => {
	it("calls source.create for matching request", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "orders",
			path: "order",
			method: "POST",
			event: "order.received",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const { source, createSpy } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ item: "widget" }),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_ACCEPTED);
		expect(await res.json()).toEqual({ accepted: true });
		expect(createSpy).toHaveBeenCalledWith("order.received", { item: "widget" }, "orders");
	});
});

describe("httpTriggerMiddleware — pass-through", () => {
	it("passes through when no trigger matches", async () => {
		const registry = new HttpTriggerRegistry();
		const { source, createSpy } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/unknown", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
		expect(createSpy).not.toHaveBeenCalled();
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
		const { source, createSpy } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/api/health", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
		expect(createSpy).not.toHaveBeenCalled();
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
		const { source, createSpy } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: "not json",
		});

		expect(res.status).toBe(constants.HTTP_STATUS_BAD_REQUEST);
		expect(createSpy).not.toHaveBeenCalled();
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
		const createSpy = vi.fn().mockRejectedValue(
			new PayloadValidationError("order.received", [
				{ path: "orderId", message: "Expected string, received number" },
			]),
		);
		const source = { create: createSpy, derive: vi.fn(), fork: vi.fn(), transition: vi.fn() } as unknown as EventSource;
		const app = createApp(registry, source);

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
		const { source } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: "abc" }),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_ACCEPTED);
		expect(await res.json()).toEqual({ accepted: true });
	});
});
