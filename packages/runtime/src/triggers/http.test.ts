import { constants } from "node:http2";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { PayloadValidationError } from "../context/errors.js";
import type { RuntimeEvent } from "../event-bus/index.js";
import type { EventSource } from "../event-source.js";
import { HttpTriggerRegistry, httpTriggerMiddleware } from "./http.js";

describe("HttpTriggerRegistry", () => {
	it("returns a registered trigger on matching path and method", () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202, body: { accepted: true } },
		});

		expect(registry.lookup("order", "POST")).toEqual({
			name: "webhook.order",
			path: "order",
			method: "POST",
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
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});

		expect(registry.lookup("order", "GET")).toBeNull();
	});
});

function stubEventSource(): {
	source: EventSource;
	createSpy: ReturnType<typeof vi.fn>;
} {
	const createSpy = vi.fn().mockResolvedValue({
		id: "evt_test",
		type: "webhook.order",
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
	const { match, handler } = httpTriggerMiddleware(
		{ triggerRegistry: registry },
		source,
	);
	app.use(match, handler);
	return app;
}

describe("httpTriggerMiddleware — matching", () => {
	it("calls source.create with full payload shape for matching request", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
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
		expect(createSpy).toHaveBeenCalledOnce();

		const [eventType, payload, sourceName] = createSpy.mock.calls[0] as [
			string,
			unknown,
			string,
		];
		expect(eventType).toBe("webhook.order");
		expect(sourceName).toBe("webhook.order");
		const p = payload as {
			body: unknown;
			headers: Record<string, string>;
			url: string;
			method: string;
		};
		expect(p.body).toEqual({ item: "widget" });
		expect(p.method).toBe("POST");
		expect(p.headers).toHaveProperty("content-type", "application/json");
		expect(p.url).toBe("http://localhost/webhooks/order");
	});

	it("includes query string in path", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { ok: true } },
		});
		const { source, createSpy } = stubEventSource();
		const app = createApp(registry, source);

		await app.request("/webhooks/order?source=shopify&ref=abc", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		const [, payload] = createSpy.mock.calls[0] as [string, { url: string }];
		expect(payload.url).toBe(
			"http://localhost/webhooks/order?source=shopify&ref=abc",
		);
	});

	it("forwards all headers including custom ones", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 200 as const },
		});
		const { source, createSpy } = stubEventSource();
		const app = createApp(registry, source);

		await app.request("/webhooks/order", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Signature": "sha256=abc",
				Authorization: "Bearer tk_test",
			},
			body: JSON.stringify({}),
		});

		const [, payload] = createSpy.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(payload.headers["x-signature"]).toBe("sha256=abc");
		expect(payload.headers.authorization).toBe("Bearer tk_test");
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
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const { source, createSpy } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/other", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
		expect(createSpy).not.toHaveBeenCalled();
	});
});

describe("httpTriggerMiddleware — webhooks status", () => {
	it("returns 204 when triggers are registered", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
		});
		const { source } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_NO_CONTENT);
	});

	it("returns 503 when no triggers are registered", async () => {
		const registry = new HttpTriggerRegistry();
		const { source } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_SERVICE_UNAVAILABLE);
	});

	it("does not interfere with POST to trigger paths", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const { source } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ item: "widget" }),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_ACCEPTED);
	});
});

describe("httpTriggerMiddleware — error handling", () => {
	it("returns 422 for non-JSON request body", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const { source, createSpy } = stubEventSource();
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: "not json",
		});

		expect(res.status).toBe(constants.HTTP_STATUS_UNPROCESSABLE_ENTITY);
		expect(createSpy).not.toHaveBeenCalled();
	});

	it("returns 422 with structured body when payload validation fails", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
			response: { status: 202 as const, body: { accepted: true } },
		});
		const createSpy = vi
			.fn()
			.mockRejectedValue(
				new PayloadValidationError("webhook.order", [
					{ path: "body.orderId", message: "Expected string, received number" },
				]),
			);
		const source = {
			create: createSpy,
			derive: vi.fn(),
			fork: vi.fn(),
			transition: vi.fn(),
		} as unknown as EventSource;
		const app = createApp(registry, source);

		const res = await app.request("/webhooks/order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderId: 123 }),
		});

		expect(res.status).toBe(constants.HTTP_STATUS_UNPROCESSABLE_ENTITY);
		expect(await res.json()).toEqual({
			error: "payload_validation_failed",
			event: "webhook.order",
			issues: [
				{ path: "body.orderId", message: "Expected string, received number" },
			],
		});
	});

	it("returns configured response when payload is valid", async () => {
		const registry = new HttpTriggerRegistry();
		registry.register({
			name: "webhook.order",
			path: "order",
			method: "POST",
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
