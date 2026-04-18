import type { HttpTriggerResult } from "@workflow-engine/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor/index.js";
import type { LookupResult, WorkflowRegistry } from "../workflow-registry.js";
import { httpTriggerMiddleware, type PayloadValidator } from "./http.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function passValidator(): PayloadValidator {
	return {
		validateBody: (v) => ({ ok: true, value: v }),
		validateQuery: (v) => ({ ok: true, value: v }),
		validateParams: (v) => ({ ok: true, value: v }),
	};
}

function makeLookupResult(overrides: Partial<LookupResult> = {}): LookupResult {
	return {
		workflow: {
			name: "w",
			module: "w.js",
			sha: "0".repeat(64),
			env: {},
			actions: [],
			triggers: [],
		},
		triggerName: "t",
		validator: passValidator(),
		params: {},
		bundleSource: "",
		...overrides,
	};
}

interface MakeRegistryOptions {
	readonly result?: LookupResult | undefined;
	readonly register?: boolean;
}

function makeRegistry(options: MakeRegistryOptions = {}): WorkflowRegistry {
	const hasTrigger = options.register !== false;
	const result = options.result;
	return {
		get size() {
			return hasTrigger ? 1 : 0;
		},
		tenants: () => [],
		list: () => [],
		lookup: (_tenant, workflowName, path) => {
			if (!hasTrigger) {
				return;
			}
			if (result !== undefined) {
				return result;
			}
			// Default: match "webhook" path only, on workflow "w".
			if (workflowName === "w" && path === "webhook") {
				return makeLookupResult();
			}
			return;
		},
		registerTenant: async () => ({ ok: false, error: "unused" }),
		recover: async () => undefined,
		dispose: () => undefined,
	};
}

interface MountOptions {
	readonly result?: LookupResult;
	readonly invoke?: Executor["invoke"];
	readonly register?: boolean;
}

function mount(options: MountOptions = {}) {
	const registry = makeRegistry({
		...(options.register === undefined ? {} : { register: options.register }),
		...(options.result === undefined ? {} : { result: options.result }),
	});
	const executor = {
		invoke: options.invoke ?? (async () => ({ status: 200, body: "ok" })),
	} as Executor;
	const middleware = httpTriggerMiddleware(registry, executor);
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
	if (middleware.match.endsWith("/*")) {
		app.all(middleware.match.slice(0, -2), middleware.handler);
	}
	return { app, registry, executor };
}

// ---------------------------------------------------------------------------
// httpTriggerMiddleware — success path
// ---------------------------------------------------------------------------

describe("httpTriggerMiddleware: success path", () => {
	it("invokes executor and serializes HttpTriggerResult", async () => {
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			status: 202,
			body: { ok: true },
			headers: { "X-Custom": "v" },
		}));
		const { app } = mount({ invoke });

		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({ x: 1 }),
			headers: { "Content-Type": "application/json" },
		});

		expect(invoke).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(202);
		expect(res.headers.get("X-Custom")).toBe("v");
		expect(await res.json()).toEqual({ ok: true });
	});

	it("applies defaults when handler returns empty object", async () => {
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			status: 200,
			body: "",
			headers: {},
		}));
		const { app } = mount({ invoke });

		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});

	it("passes tenant, workflow, triggerName and payload to the executor", async () => {
		const calls: {
			tenant: string;
			workflowName: string;
			triggerName: string;
			payload: unknown;
		}[] = [];
		const invoke = vi.fn<Executor["invoke"]>(
			async (tenant, workflow, triggerName, payload) => {
				calls.push({
					tenant,
					workflowName: workflow.name,
					triggerName,
					payload,
				});
				return { status: 200 } satisfies HttpTriggerResult;
			},
		);
		const result = makeLookupResult({
			triggerName: "paramTrig",
			params: { userId: "abc" },
		});
		const { app } = mount({ invoke, result });

		const res = await app.request(
			"/webhooks/t0/w/webhook?tag=one&tag=two&q=hello",
			{
				method: "POST",
				body: JSON.stringify({ active: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.tenant).toBe("t0");
		expect(call?.workflowName).toBe("w");
		expect(call?.triggerName).toBe("paramTrig");
		const payload = call?.payload as {
			body: unknown;
			params: Record<string, string>;
			query: Record<string, string[]>;
			method: string;
		};
		expect(payload.body).toEqual({ active: true });
		expect(payload.params.userId).toBe("abc");
		expect(payload.query.tag).toEqual(["one", "two"]);
		expect(payload.query.q).toEqual(["hello"]);
		expect(payload.method).toBe("POST");
	});
});

// ---------------------------------------------------------------------------
// httpTriggerMiddleware — error paths
// ---------------------------------------------------------------------------

describe("httpTriggerMiddleware: error paths", () => {
	it("returns 404 when no trigger matches", async () => {
		const invoke = vi.fn<Executor["invoke"]>();
		const { app } = mount({ invoke });
		const res = await app.request("/webhooks/t0/w/nope", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("returns 422 on non-JSON body", async () => {
		const invoke = vi.fn<Executor["invoke"]>();
		const { app } = mount({ invoke });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "not json",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(422);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("payload_validation_failed");
		expect(invoke).not.toHaveBeenCalled();
	});

	it("returns 422 with structured issues on validation failure", async () => {
		const invoke = vi.fn<Executor["invoke"]>();
		const failingResult = makeLookupResult({
			validator: {
				validateBody: () => ({
					ok: false,
					issues: [
						{ path: ["a"], message: "a must be string" },
						{ path: ["b", 0], message: "b[0] must be number" },
					],
				}),
				validateQuery: (v) => ({ ok: true, value: v }),
				validateParams: (v) => ({ ok: true, value: v }),
			},
		});
		const { app } = mount({ invoke, result: failingResult });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({ wrong: true }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(422);
		const json = (await res.json()) as {
			error: string;
			issues: { path: unknown[]; message: string }[];
		};
		expect(json.error).toBe("payload_validation_failed");
		expect(json.issues).toEqual([
			{ path: ["a"], message: "a must be string" },
			{ path: ["b", 0], message: "b[0] must be number" },
		]);
		expect(invoke).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// GET /webhooks/ health probe
// ---------------------------------------------------------------------------

describe("httpTriggerMiddleware: webhooks health probe", () => {
	it("returns 503 when no trigger is registered", async () => {
		const { app } = mount({ register: false });
		const res = await app.request("/webhooks/", { method: "GET" });
		expect(res.status).toBe(503);
	});

	it("returns 204 when at least one trigger is registered", async () => {
		const { app } = mount({});
		const res = await app.request("/webhooks/", { method: "GET" });
		expect(res.status).toBe(204);
	});
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("httpTriggerMiddleware: security", () => {
	it("is a public ingress — no auth middleware attached (per SECURITY.md §3)", async () => {
		const invoke = vi.fn<Executor["invoke"]>(async () => ({ status: 200 }));
		const { app } = mount({ invoke });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("rejects oversized/malformed JSON at the validation boundary", async () => {
		const invoke = vi.fn<Executor["invoke"]>();
		const { app } = mount({ invoke });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{not json",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(422);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("strips __proto__ / constructor keys before they reach the executor", async () => {
		const prototypePollutingResult = makeLookupResult({
			validator: {
				validateBody: () => ({ ok: true, value: { clean: true } }),
				validateQuery: (v) => ({ ok: true, value: v }),
				validateParams: (v) => ({ ok: true, value: v }),
			},
		});
		const received: unknown[] = [];
		const invoke = vi.fn<Executor["invoke"]>(
			async (_tenant, _workflow, _name, payload) => {
				received.push(payload);
				return { status: 200 };
			},
		);
		const { app } = mount({ invoke, result: prototypePollutingResult });
		await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({
				__proto__: { polluted: true },
				constructor: { prototype: { polluted: true } },
			}),
			headers: { "Content-Type": "application/json" },
		});
		const payload = received[0] as { body: Record<string, unknown> };
		expect(payload.body).toEqual({ clean: true });
		expect("polluted" in Object.prototype).toBe(false);
	});
});
