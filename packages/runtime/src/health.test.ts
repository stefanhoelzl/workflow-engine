import { constants } from "node:http2";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "./event-store.js";
import {
	type CheckResult,
	type HealthDeps,
	type HealthResponse,
	healthMiddleware,
} from "./health.js";

const CONTENT_TYPE = "application/health+json";

function stubEventStore(overrides?: Partial<EventStore>): EventStore {
	return {
		query: vi.fn(),
		ping: vi.fn().mockResolvedValue(undefined),
		record: vi.fn(),
		hasUploadEvent: vi.fn().mockResolvedValue(false),
		with: vi.fn(),
		drainAndClose: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as EventStore;
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
		baseUrl: undefined,
		gitSha: "dev",
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
				baseUrl: "http://localhost:8080",
			}),
		);

		const res = await app.request("/readyz", { method: "GET" });

		const body = (await res.json()) as HealthResponse;
		expect(res.status).toBe(constants.HTTP_STATUS_OK);
		expect(body.status).toBe("pass");
		expect(body.checks).toBeDefined();
		expect(body.checks?.eventstore?.[0]?.status).toBe("pass");
		expect(body.checks?.webhooks?.[0]?.status).toBe("pass");
		expect(body.checks?.domain?.[0]?.status).toBe("pass");

		vi.unstubAllGlobals();
	});

	it("with missing deps returns 503 with failures for unconfigured checks", async () => {
		const app = createApp(
			defaultDeps({
				eventStore: stubEventStore(),
				baseUrl: undefined,
			}),
		);

		const res = await app.request("/readyz", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_SERVICE_UNAVAILABLE);
		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("fail");

		// eventstore should pass
		expect(body.checks?.eventstore?.[0]?.status).toBe("pass");

		// webhooks and domain should fail
		expect(body.checks?.webhooks?.[0]?.status).toBe("fail");
		expect(body.checks?.webhooks?.[0]?.output).toBe("BASE_URL not configured");
		expect(body.checks?.domain?.[0]?.status).toBe("fail");
		expect(body.checks?.domain?.[0]?.output).toBe("BASE_URL not configured");
	});

	it("includes the build's git sha in the response body", async () => {
		const app = createApp(defaultDeps({ gitSha: "abc123" }));

		const res = await app.request("/readyz", { method: "GET" });
		const body = (await res.json()) as HealthResponse;
		expect(body.version).toEqual({ gitSha: "abc123" });
	});

	it("falls back to a 'dev' sentinel when no sha is configured", async () => {
		const app = createApp(defaultDeps());

		const res = await app.request("/readyz", { method: "GET" });
		const body = (await res.json()) as HealthResponse;
		expect(body.version).toEqual({ gitSha: "dev" });
	});
});

describe("passthrough", () => {
	it("does not intercept unrelated routes", async () => {
		const app = createApp(defaultDeps());

		const res = await app.request("/dashboard/", { method: "GET" });

		expect(res.status).toBe(constants.HTTP_STATUS_NOT_FOUND);
	});
});
