import { constants } from "node:http2";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "./event-bus/event-store.js";
import {
	type CheckResult,
	type HealthDeps,
	type HealthResponse,
	healthMiddleware,
} from "./health.js";
import type { StorageBackend } from "./storage/index.js";

const CONTENT_TYPE = "application/health+json";

function stubEventStore(overrides?: Partial<EventStore>): EventStore {
	return {
		query: vi.fn(),
		ping: vi.fn().mockResolvedValue(undefined),
		handle: vi.fn(),
		with: vi.fn(),
		...overrides,
	} as unknown as EventStore;
}

function stubStorageBackend(): StorageBackend {
	return {
		init: vi.fn().mockResolvedValue(undefined),
		write: vi.fn().mockResolvedValue(undefined),
		writeBytes: vi.fn().mockResolvedValue(undefined),
		read: vi.fn().mockResolvedValue("2026-01-01T00:00:00.000Z"),
		readBytes: vi.fn().mockResolvedValue(new Uint8Array(0)),
		list: vi.fn().mockImplementation(async function* () {
			// empty iterator
		}),
		remove: vi.fn().mockResolvedValue(undefined),
		removePrefix: vi.fn().mockResolvedValue(undefined),
		move: vi.fn().mockResolvedValue(undefined),
	};
}

function createApp(deps: HealthDeps): Hono {
	const app = new Hono();
	const { match, handler } = healthMiddleware(deps);
	app.use(match, handler);
	return app;
}

function defaultDeps(overrides?: Partial<HealthDeps>): HealthDeps {
	return {
		eventStore: stubEventStore(),
		storageBackend: undefined,
		baseUrl: undefined,
		...overrides,
	};
}

describe("GET /livez", () => {
	it("returns 200 with correct content-type and body", async () => {
		const app = createApp(defaultDeps());

		const res = await app.request("/livez", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_OK);
		expect(res.headers.get("content-type")).toContain(CONTENT_TYPE);
		const body = (await res.json()) as HealthResponse;
		expect(body).toEqual({ status: "pass" });
	});
});

describe("GET /healthz", () => {
	it("shallow returns 200 with pass status", async () => {
		const app = createApp(defaultDeps());

		const res = await app.request("/healthz", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_OK);
		expect(res.headers.get("content-type")).toContain(CONTENT_TYPE);
		const body = (await res.json()) as HealthResponse;
		expect(body).toEqual({ status: "pass" });
	});

	it("eventstore check returns IETF format with duration", async () => {
		const app = createApp(defaultDeps({ eventStore: stubEventStore() }));

		const res = await app.request("/healthz?eventstore=true", {
			method: "GET",
		});

		expect(res.status).toBe(constants.HTTP_STATUS_OK);
		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("pass");
		expect(body.checks).toBeDefined();

		const check = body.checks?.eventstore?.[0] as CheckResult;
		expect(check.status).toBe("pass");
		expect(check.componentType).toBe("datastore");
		expect(check.observedUnit).toBe("ms");
		expect(typeof check.observedValue).toBe("number");
	});

	it("persistence check without backend returns 503 with no backend configured", async () => {
		const app = createApp(defaultDeps({ storageBackend: undefined }));

		const res = await app.request("/healthz?persistence=true", {
			method: "GET",
		});

		expect(res.status).toBe(constants.HTTP_STATUS_SERVICE_UNAVAILABLE);
		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("fail");

		for (const key of [
			"persistence:write",
			"persistence:read",
			"persistence:list",
		]) {
			const check = body.checks?.[key]?.[0] as CheckResult;
			expect(check.status).toBe("fail");
			expect(check.output).toBe("no backend configured");
		}
	});

	it("persistence check with backend runs write/read/list and returns pass", async () => {
		const backend = stubStorageBackend();
		const app = createApp(defaultDeps({ storageBackend: backend }));

		const res = await app.request("/healthz?persistence=true", {
			method: "GET",
		});

		expect(res.status).toBe(constants.HTTP_STATUS_OK);
		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("pass");

		for (const key of [
			"persistence:write",
			"persistence:read",
			"persistence:list",
		]) {
			const check = body.checks?.[key]?.[0] as CheckResult;
			expect(check.status).toBe("pass");
			expect(check.componentType).toBe("datastore");
			expect(check.observedUnit).toBe("ms");
			expect(typeof check.observedValue).toBe("number");
		}

		expect(backend.write).toHaveBeenCalledWith(
			".healthz/sentinel",
			expect.any(String),
		);
		expect(backend.read).toHaveBeenCalledWith(".healthz/sentinel");
		expect(backend.list).toHaveBeenCalledWith("pending/");
	});

	it("webhooks check without BASE_URL returns 503", async () => {
		const app = createApp(defaultDeps({ baseUrl: undefined }));

		const res = await app.request("/healthz?webhooks=true", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_SERVICE_UNAVAILABLE);
		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("fail");
		const check = body.checks?.webhooks?.[0] as CheckResult;
		expect(check.status).toBe("fail");
		expect(check.output).toBe("BASE_URL not configured");
	});

	it("domain check without BASE_URL returns 503", async () => {
		const app = createApp(defaultDeps({ baseUrl: undefined }));

		const res = await app.request("/healthz?domain=true", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_SERVICE_UNAVAILABLE);
		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("fail");
		const check = body.checks?.domain?.[0] as CheckResult;
		expect(check.status).toBe("fail");
		expect(check.output).toBe("BASE_URL not configured");
	});

	it("custom timeout is applied via query param", async () => {
		const slowEventStore = stubEventStore({
			ping: vi
				.fn()
				.mockImplementation(
					() =>
						new Promise<void>((resolve) => setTimeout(() => resolve(), 200)),
				),
		});
		const app = createApp(defaultDeps({ eventStore: slowEventStore }));

		const res = await app.request("/healthz?eventstore=true&timeout=50", {
			method: "GET",
		});

		expect(res.status).toBe(constants.HTTP_STATUS_SERVICE_UNAVAILABLE);
		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("fail");
		const check = body.checks?.eventstore?.[0] as CheckResult;
		expect(check.status).toBe("fail");
		expect(check.output).toContain("timeout");
	});
});

describe("GET /readyz", () => {
	it("with all deps configured and healthy returns 200", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: "pass" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);

		const app = createApp(
			defaultDeps({
				eventStore: stubEventStore(),
				storageBackend: stubStorageBackend(),
				baseUrl: "http://localhost:8080",
			}),
		);

		const res = await app.request("/readyz", { method: "GET" });

		const body = (await res.json()) as HealthResponse;
		expect(res.status).toBe(constants.HTTP_STATUS_OK);
		expect(body.status).toBe("pass");
		expect(body.checks).toBeDefined();
		expect(body.checks?.eventstore?.[0]?.status).toBe("pass");
		expect(body.checks?.["persistence:write"]?.[0]?.status).toBe("pass");
		expect(body.checks?.["persistence:read"]?.[0]?.status).toBe("pass");
		expect(body.checks?.["persistence:list"]?.[0]?.status).toBe("pass");
		expect(body.checks?.webhooks?.[0]?.status).toBe("pass");
		expect(body.checks?.domain?.[0]?.status).toBe("pass");

		vi.unstubAllGlobals();
	});

	it("with missing deps returns 503 with failures for unconfigured checks", async () => {
		const app = createApp(
			defaultDeps({
				eventStore: stubEventStore(),
				storageBackend: undefined,
				baseUrl: undefined,
			}),
		);

		const res = await app.request("/readyz", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_SERVICE_UNAVAILABLE);
		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("fail");

		// eventstore should pass
		expect(body.checks?.eventstore?.[0]?.status).toBe("pass");

		// persistence checks should fail
		for (const key of [
			"persistence:write",
			"persistence:read",
			"persistence:list",
		]) {
			expect(body.checks?.[key]?.[0]?.status).toBe("fail");
			expect(body.checks?.[key]?.[0]?.output).toBe("no backend configured");
		}

		// webhooks and domain should fail
		expect(body.checks?.webhooks?.[0]?.status).toBe("fail");
		expect(body.checks?.webhooks?.[0]?.output).toBe("BASE_URL not configured");
		expect(body.checks?.domain?.[0]?.status).toBe("fail");
		expect(body.checks?.domain?.[0]?.output).toBe("BASE_URL not configured");
	});
});

describe("passthrough", () => {
	it("does not intercept unrelated routes", async () => {
		const app = createApp(defaultDeps());

		const res = await app.request("/dashboard/", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
	});
});
