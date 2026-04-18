import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowRunner } from "../../executor/types.js";
import type {
	HttpTriggerEntry,
	HttpTriggerRegistry,
} from "../../triggers/http.js";
import { triggerMiddleware } from "./middleware.js";
import { prepareSchema } from "./page.js";

function makeRegistry(entries: HttpTriggerEntry[]): HttpTriggerRegistry {
	return {
		register: vi.fn(),
		removeRunner: vi.fn(),
		lookup: vi.fn(),
		list: () => entries,
		get size() {
			return entries.length;
		},
	};
}

function makeRunner(name: string): WorkflowRunner {
	return {
		tenant: "t0",
		name,
		env: {},
		actions: [],
		triggers: [],
		invokeHandler: async () => ({}),
		onEvent: () => {
			/* no-op for tests */
		},
	};
}

function mount(registry: HttpTriggerRegistry) {
	const m = triggerMiddleware({ triggerRegistry: registry });
	const app = new Hono();
	app.all(m.match, m.handler);
	if (m.match.endsWith("/*")) {
		app.all(m.match.slice(0, -2), m.handler);
	}
	return app;
}

// User name is "user" so alphabetical sort of (orgs ∪ {name}) = ["t0","user"]
// → active tenant defaults to "t0", the default tenant assigned by makeRunner.
const AUTH_HEADERS = {
	"X-Auth-Request-User": "user",
	"X-Auth-Request-Email": "user@example.test",
	"X-Auth-Request-Groups": "t0",
};

describe("triggerMiddleware", () => {
	it("renders a card per registered trigger including its webhook URL and method", async () => {
		const runner = makeRunner("cronitor");
		const registry = makeRegistry([
			{
				workflow: runner,
				descriptor: {
					name: "onCronitorEvent",
					type: "http",
					path: "cronitor",
					method: "POST",
					params: [],
					body: { parse: (x) => x },
				},
				schema: {
					type: "object",
					properties: {
						body: {
							type: "object",
							properties: { id: { type: "string" } },
							required: ["id"],
						},
						headers: { type: "object" },
						url: { type: "string" },
						method: { type: "string" },
						params: { type: "object" },
					},
				},
			},
		]);

		const app = mount(registry);
		const res = await app.request("/trigger/", { headers: AUTH_HEADERS });
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("cronitor / onCronitorEvent");
		expect(body).toContain("/webhooks/t0/cronitor/cronitor");
		expect(body).toContain('data-trigger-method="POST"');
		// JSON schema is embedded as an inert JSON script tag.
		expect(body).toContain('{"type":"object"');
	});

	it("renders an empty-state when no triggers are registered", async () => {
		const registry = makeRegistry([]);
		const app = mount(registry);
		const res = await app.request("/trigger/", { headers: AUTH_HEADERS });
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("No triggers registered");
	});

	it("sorts cards by workflow/trigger name (stable output)", async () => {
		const registry = makeRegistry([
			{
				workflow: makeRunner("zeta"),
				descriptor: {
					name: "z",
					type: "http",
					path: "z",
					method: "POST",
					params: [],
					body: { parse: (x) => x },
				},
			},
			{
				workflow: makeRunner("alpha"),
				descriptor: {
					name: "a",
					type: "http",
					path: "a",
					method: "GET",
					params: [],
					body: { parse: (x) => x },
				},
			},
		]);
		const app = mount(registry);
		const res = await app.request("/trigger/", { headers: AUTH_HEADERS });
		const body = await res.text();
		const alphaIdx = body.indexOf("alpha / a");
		const zetaIdx = body.indexOf("zeta / z");
		expect(alphaIdx).toBeGreaterThan(-1);
		expect(zetaIdx).toBeGreaterThan(alphaIdx);
	});
});

describe("prepareSchema", () => {
	it("promotes example to default when no default exists", () => {
		const schema = {
			type: "object",
			properties: {
				orderId: { type: "string", example: "ORD-12345" },
				amount: { type: "number", example: 42.99 },
			},
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		expect(props.orderId?.default).toBe("ORD-12345");
		expect(props.amount?.default).toBe(42.99);
	});

	it("preserves existing default when both default and example exist", () => {
		const schema = {
			type: "string",
			example: "ORD-12345",
			default: "REAL-DEFAULT",
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		expect(result.default).toBe("REAL-DEFAULT");
	});

	it("adds titles to anyOf variants and puts null first", () => {
		const schema = {
			type: "object",
			properties: {
				name: { anyOf: [{ type: "string" }, { type: "null" }] },
			},
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		const name = props.name as Record<string, unknown>;
		expect(name.anyOf).toEqual([
			{ type: "null", title: "null" },
			{ type: "string", title: "string" },
		]);
	});
});
