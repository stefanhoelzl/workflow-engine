import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type {
	WorkflowEntry,
	WorkflowRegistry,
} from "../../workflow-registry.js";
import { triggerMiddleware } from "./middleware.js";
import { prepareSchema } from "./page.js";

function makeRegistry(entries: WorkflowEntry[]): WorkflowRegistry {
	return {
		get size() {
			return entries.reduce((sum, e) => sum + e.triggers.length, 0);
		},
		tenants: () => Array.from(new Set(entries.map((e) => e.tenant))),
		list: (tenant?: string) =>
			tenant === undefined
				? entries
				: entries.filter((e) => e.tenant === tenant),
		lookup: () => undefined,
		registerTenant: async () => ({ ok: false, error: "unused" }),
		recover: async () => undefined,
		dispose: () => undefined,
	};
}

function makeEntry(
	tenant: string,
	workflowName: string,
	triggerSpec: {
		triggerName: string;
		path: string;
		method: string;
		schema?: Record<string, unknown>;
	},
): WorkflowEntry {
	return {
		tenant,
		workflow: {
			name: workflowName,
			module: `${workflowName}.js`,
			sha: "0".repeat(64),
			env: {},
			actions: [],
			triggers: [],
		},
		bundleSource: "",
		triggers: [
			{
				triggerName: triggerSpec.triggerName,
				path: triggerSpec.path,
				method: triggerSpec.method,
				schema: triggerSpec.schema ?? { type: "object" },
			},
		],
	};
}

function mount(registry: WorkflowRegistry) {
	const m = triggerMiddleware({ registry });
	const app = new Hono();
	app.all(m.match, m.handler);
	if (m.match.endsWith("/*")) {
		app.all(m.match.slice(0, -2), m.handler);
	}
	return app;
}

// User name is "user" so alphabetical sort of (orgs ∪ {name}) = ["t0","user"]
// → active tenant defaults to "t0", the default tenant assigned by makeEntry.
const AUTH_HEADERS = {
	"X-Auth-Request-User": "user",
	"X-Auth-Request-Email": "user@example.test",
	"X-Auth-Request-Groups": "t0",
};

describe("triggerMiddleware", () => {
	it("renders a card per registered trigger including its webhook URL and method", async () => {
		const registry = makeRegistry([
			makeEntry("t0", "cronitor", {
				triggerName: "onCronitorEvent",
				path: "cronitor",
				method: "POST",
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
			}),
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
			makeEntry("t0", "zeta", {
				triggerName: "z",
				path: "z",
				method: "POST",
			}),
			makeEntry("t0", "alpha", {
				triggerName: "a",
				path: "a",
				method: "GET",
			}),
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
