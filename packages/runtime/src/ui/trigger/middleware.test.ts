import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
	InvokeResult,
} from "../../executor/types.js";
import type { TriggerEntry } from "../../triggers/source.js";
import { validate } from "../../triggers/validator.js";
import type {
	WorkflowEntry,
	WorkflowRegistry,
} from "../../workflow-registry.js";
import { triggerMiddleware } from "./middleware.js";
import { prepareSchema } from "./page.js";

type Fire = (input: unknown) => Promise<InvokeResult<unknown>>;

interface StubEntry {
	readonly tenant: string;
	readonly workflowName: string;
	readonly triggerName: string;
	readonly triggerEntry: TriggerEntry;
	readonly workflowEntry: WorkflowEntry;
}

function makeStubRegistry(entries: StubEntry[]): WorkflowRegistry {
	const byKey = new Map<string, TriggerEntry>();
	for (const e of entries) {
		byKey.set(`${e.tenant}/${e.workflowName}/${e.triggerName}`, e.triggerEntry);
	}
	const flatWorkflowEntries = entries.map((e) => e.workflowEntry);
	// De-duplicate by (tenant, workflow.name) so list() returns one entry
	// per workflow even if the workflow has multiple stub triggers.
	const deduped: WorkflowEntry[] = [];
	const seen = new Set<string>();
	for (const we of flatWorkflowEntries) {
		const key = `${we.tenant}/${we.workflow.name}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(we);
	}
	return {
		get size() {
			return entries.length;
		},
		tenants: () => Array.from(new Set(entries.map((e) => e.tenant))),
		list: (tenant?: string) =>
			tenant === undefined
				? deduped
				: deduped.filter((we) => we.tenant === tenant),
		registerTenant: async () => ({ ok: false, error: "unused" }),
		recover: async () => undefined,
		getEntry: (tenant, workflowName, triggerName) =>
			byKey.get(`${tenant}/${workflowName}/${triggerName}`),
		dispose: () => undefined,
	};
}

function makeHttpStub(
	tenant: string,
	workflowName: string,
	spec: {
		name: string;
		method: string;
		body?: Record<string, unknown>;
		inputSchema?: Record<string, unknown>;
	},
	fire?: Fire,
): StubEntry {
	const descriptor: HttpTriggerDescriptor = {
		kind: "http",
		type: "http",
		name: spec.name,
		workflowName,
		method: spec.method,
		body: spec.body ?? { type: "object" },
		inputSchema: spec.inputSchema ?? { type: "object" },
		outputSchema: { type: "object" },
	};
	const defaultFire: Fire = async (input) => {
		const v = validate(descriptor, input);
		if (!v.ok) {
			return {
				ok: false,
				error: {
					message: "payload_validation_failed",
					issues: v.issues,
				},
			};
		}
		return { ok: true, output: { status: 200 } };
	};
	const triggerEntry: TriggerEntry = {
		descriptor,
		fire: fire ?? defaultFire,
	};
	return {
		tenant,
		workflowName,
		triggerName: spec.name,
		triggerEntry,
		workflowEntry: {
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
		},
	};
}

function makeCronStub(
	tenant: string,
	workflowName: string,
	spec: { name: string; schedule: string; tz: string },
	fire?: Fire,
): StubEntry {
	const descriptor: CronTriggerDescriptor = {
		kind: "cron",
		type: "cron",
		name: spec.name,
		workflowName,
		schedule: spec.schedule,
		tz: spec.tz,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
	};
	const defaultFire: Fire = async () => ({
		ok: true,
		output: undefined,
	});
	const triggerEntry: TriggerEntry = {
		descriptor,
		fire: fire ?? defaultFire,
	};
	return {
		tenant,
		workflowName,
		triggerName: spec.name,
		triggerEntry,
		workflowEntry: {
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
		},
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

const AUTH_HEADERS = {
	"X-Auth-Request-User": "user",
	"X-Auth-Request-Email": "user@example.test",
	"X-Auth-Request-Groups": "t0",
};

describe("triggerMiddleware: page rendering", () => {
	it("renders a card per registered trigger with kind icon, webhook URL and method", async () => {
		const registry = makeStubRegistry([
			makeHttpStub("t0", "cronitor", {
				name: "onCronitorEvent",

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
		expect(body).toContain(
			'data-trigger-url="/webhooks/t0/cronitor/onCronitorEvent"',
		);
		expect(body).toContain('data-trigger-method="POST"');
		expect(body).toContain('{"type":"object"');
		expect(body).toContain('title="http"');
	});

	it("renders an empty-state when no triggers are registered", async () => {
		const registry = makeStubRegistry([]);
		const app = mount(registry);
		const res = await app.request("/trigger/", { headers: AUTH_HEADERS });
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("No triggers registered");
	});

	it("sorts cards by workflow/trigger name (stable output)", async () => {
		const registry = makeStubRegistry([
			makeHttpStub("t0", "zeta", { name: "z", method: "POST" }),
			makeHttpStub("t0", "alpha", { name: "a", method: "GET" }),
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
	it("invokes entry.fire for a matching POST", async () => {
		const fire = vi.fn<Fire>(async () => ({
			ok: true,
			output: { status: 202, body: { echoed: true } },
		}));
		const registry = makeStubRegistry([
			makeHttpStub(
				"t0",
				"demo",
				{
					name: "onPing",

					method: "POST",
					inputSchema: {
						type: "object",
						properties: { x: { type: "number" } },
						required: ["x"],
					},
				},
				fire,
			),
		]);
		const app = mount(registry);
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
		expect(fire).toHaveBeenCalledTimes(1);
		expect(fire.mock.calls[0]?.[0]).toEqual({ x: 42 });
	});

	it("returns 422 when fire reports a validation failure", async () => {
		const registry = makeStubRegistry([
			makeHttpStub("t0", "demo", {
				name: "onPing",

				method: "POST",
				inputSchema: {
					type: "object",
					properties: { x: { type: "number" } },
					required: ["x"],
				},
			}),
		]);
		const app = mount(registry);
		const res = await app.request("/trigger/t0/demo/onPing", {
			method: "POST",
			body: JSON.stringify({ x: "not-a-number" }),
			headers: {
				"Content-Type": "application/json",
				...AUTH_HEADERS,
			},
		});
		expect(res.status).toBe(422);
	});

	it("returns 404 for an unknown trigger name", async () => {
		const registry = makeStubRegistry([
			makeHttpStub("t0", "demo", {
				name: "onPing",

				method: "POST",
			}),
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

	it("returns 500 when fire reports a non-validation failure", async () => {
		const fire = vi.fn<Fire>(async () => ({
			ok: false,
			error: { message: "boom" },
		}));
		const registry = makeStubRegistry([
			makeHttpStub("t0", "demo", { name: "onPing", method: "POST" }, fire),
		]);
		const app = mount(registry);
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
		const registry = makeStubRegistry([
			makeCronStub("t0", "billing", {
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
		expect(body).toContain("0 9 * * *");
		expect(body).toContain("UTC");
	});

	it("dispatches a manual cron fire via entry.fire with empty payload", async () => {
		const fire = vi.fn<Fire>(async () => ({
			ok: true,
			output: undefined,
		}));
		const registry = makeStubRegistry([
			makeCronStub(
				"t0",
				"billing",
				{ name: "daily", schedule: "0 9 * * *", tz: "UTC" },
				fire,
			),
		]);
		const app = mount(registry);
		const res = await app.request("/trigger/t0/billing/daily", {
			method: "POST",
			headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(200);
		expect(fire).toHaveBeenCalledTimes(1);
		expect(fire.mock.calls[0]?.[0]).toEqual({});
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
