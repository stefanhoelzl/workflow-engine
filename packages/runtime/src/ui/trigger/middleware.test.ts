import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../../executor/index.js";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
} from "../../executor/types.js";
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
		registerTenant: async () => ({ ok: false, error: "unused" }),
		recover: async () => undefined,
		dispose: () => undefined,
	};
}

function makeEntry(
	tenant: string,
	workflowName: string,
	triggerSpec: {
		name: string;
		path: string;
		method: string;
		body?: Record<string, unknown>;
		inputSchema?: Record<string, unknown>;
	},
): WorkflowEntry {
	const descriptor: HttpTriggerDescriptor = {
		kind: "http",
		type: "http",
		name: triggerSpec.name,
		path: triggerSpec.path,
		method: triggerSpec.method,
		params: [],
		body: triggerSpec.body ?? { type: "object" },
		inputSchema: triggerSpec.inputSchema ?? { type: "object" },
		outputSchema: { type: "object" },
	};
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
		triggers: [descriptor],
	};
}

function makeCronEntry(
	tenant: string,
	workflowName: string,
	spec: { name: string; schedule: string; tz: string },
): WorkflowEntry {
	const descriptor: CronTriggerDescriptor = {
		kind: "cron",
		type: "cron",
		name: spec.name,
		schedule: spec.schedule,
		tz: spec.tz,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
	};
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
		triggers: [descriptor],
	};
}

function defaultInvoke(): Executor["invoke"] {
	return async () => ({ ok: true as const, output: { status: 200 } });
}

function mount(
	registry: WorkflowRegistry,
	invoke: Executor["invoke"] = defaultInvoke(),
) {
	const m = triggerMiddleware({
		registry,
		executor: { invoke } as Executor,
	});
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

describe("triggerMiddleware: page rendering", () => {
	it("renders a card per registered trigger with kind icon, webhook URL and method", async () => {
		const registry = makeRegistry([
			makeEntry("t0", "cronitor", {
				name: "onCronitorEvent",
				path: "cronitor",
				method: "POST",
				body: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
				},
			}),
		]);

		const app = mount(registry);
		const res = await app.request("/trigger/", { headers: AUTH_HEADERS });
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("cronitor / onCronitorEvent");
		// HTTP-kind submit URL is the public webhook URL.
		expect(body).toContain('data-trigger-url="/webhooks/t0/cronitor/cronitor"');
		expect(body).toContain('data-trigger-method="POST"');
		// JSON body schema is embedded as an inert JSON script tag.
		expect(body).toContain('{"type":"object"');
		// Kind icon.
		expect(body).toContain('title="http"');
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
			makeEntry("t0", "zeta", { name: "z", path: "z", method: "POST" }),
			makeEntry("t0", "alpha", { name: "a", path: "a", method: "GET" }),
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

describe("triggerMiddleware: POST dispatch", () => {
	it("validates + dispatches a matching POST via the executor", async () => {
		const registry = makeRegistry([
			makeEntry("t0", "demo", {
				name: "onPing",
				path: "ping",
				method: "POST",
				inputSchema: {
					type: "object",
					properties: { x: { type: "number" } },
					required: ["x"],
				},
			}),
		]);
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true,
			output: { status: 202, body: { echoed: true } },
		}));
		const app = mount(registry, invoke);
		const res = await app.request("/trigger/t0/demo/onPing", {
			method: "POST",
			body: JSON.stringify({ x: 42 }),
			headers: {
				"Content-Type": "application/json",
				...AUTH_HEADERS,
			},
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; output: unknown };
		expect(json.ok).toBe(true);
		expect(json.output).toEqual({ status: 202, body: { echoed: true } });
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("returns 422 when the body fails inputSchema validation", async () => {
		const registry = makeRegistry([
			makeEntry("t0", "demo", {
				name: "onPing",
				path: "ping",
				method: "POST",
				inputSchema: {
					type: "object",
					properties: { x: { type: "number" } },
					required: ["x"],
				},
			}),
		]);
		const invoke = vi.fn<Executor["invoke"]>();
		const app = mount(registry, invoke);
		const res = await app.request("/trigger/t0/demo/onPing", {
			method: "POST",
			body: JSON.stringify({ x: "not-a-number" }),
			headers: {
				"Content-Type": "application/json",
				...AUTH_HEADERS,
			},
		});
		expect(res.status).toBe(422);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("returns 404 for an unknown trigger name", async () => {
		const registry = makeRegistry([
			makeEntry("t0", "demo", { name: "onPing", path: "ping", method: "POST" }),
		]);
		const app = mount(registry);
		const res = await app.request("/trigger/t0/demo/nonexistent", {
			method: "POST",
			body: "{}",
			headers: {
				"Content-Type": "application/json",
				...AUTH_HEADERS,
			},
		});
		expect(res.status).toBe(404);
	});

	it("returns 500 when the executor returns an error sentinel", async () => {
		const registry = makeRegistry([
			makeEntry("t0", "demo", { name: "onPing", path: "ping", method: "POST" }),
		]);
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: false,
			error: { message: "boom" },
		}));
		const app = mount(registry, invoke);
		const res = await app.request("/trigger/t0/demo/onPing", {
			method: "POST",
			body: "{}",
			headers: {
				"Content-Type": "application/json",
				...AUTH_HEADERS,
			},
		});
		expect(res.status).toBe(500);
	});
});

describe("triggerMiddleware: cron trigger rendering + dispatch", () => {
	it("renders a cron trigger card with schedule+tz meta and /trigger/ POST URL", async () => {
		const registry = makeRegistry([
			makeCronEntry("t0", "billing", {
				name: "daily",
				schedule: "0 9 * * *",
				tz: "UTC",
			}),
		]);
		const app = mount(registry);
		const res = await app.request("/trigger/", { headers: AUTH_HEADERS });
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("billing / daily");
		expect(body).toContain('title="cron"');
		expect(body).toContain('data-trigger-url="/trigger/t0/billing/daily"');
		expect(body).toContain('data-trigger-method="POST"');
		// Schedule and tz appear in the meta label.
		expect(body).toContain("0 9 * * *");
		expect(body).toContain("UTC");
	});

	it("dispatches a manual cron fire via executor.invoke with empty payload", async () => {
		const registry = makeRegistry([
			makeCronEntry("t0", "billing", {
				name: "daily",
				schedule: "0 9 * * *",
				tz: "UTC",
			}),
		]);
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true as const,
			output: undefined,
		}));
		const app = mount(registry, invoke);
		const res = await app.request("/trigger/t0/billing/daily", {
			method: "POST",
			headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(200);
		expect(invoke).toHaveBeenCalledTimes(1);
		const call = invoke.mock.calls[0];
		expect(call?.[0]).toBe("t0");
		expect((call?.[2] as CronTriggerDescriptor).name).toBe("daily");
		expect(call?.[3]).toEqual({});
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
