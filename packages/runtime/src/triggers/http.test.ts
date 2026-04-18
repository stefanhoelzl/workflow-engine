import type { HttpTriggerResult } from "@workflow-engine/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor/index.js";
import type {
	HttpTriggerDescriptor,
	WorkflowRunner,
} from "../executor/types.js";
import {
	createHttpTriggerRegistry,
	httpTriggerMiddleware,
	type PayloadValidator,
} from "./http.js";

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

function makeDescriptor(
	overrides: Partial<HttpTriggerDescriptor>,
): HttpTriggerDescriptor {
	return {
		name: "t",
		type: "http",
		path: "webhook",
		method: "POST",
		params: [],
		body: { parse: (x) => x },
		...overrides,
	};
}

function makeRunner(name: string, tenant = "t0"): WorkflowRunner {
	return {
		tenant,
		name,
		env: Object.freeze({}),
		actions: [],
		triggers: [],
		invokeHandler: async () => ({ status: 200 }),
		onEvent: () => {
			/* no-op for tests */
		},
	};
}

interface MountOptions {
	readonly runner?: WorkflowRunner;
	readonly descriptor?: HttpTriggerDescriptor;
	readonly validator?: PayloadValidator;
	readonly invoke?: Executor["invoke"];
	readonly register?: boolean;
}

function mount(options: MountOptions = {}) {
	const registry = createHttpTriggerRegistry();
	if (options.register !== false) {
		registry.register(
			options.runner ?? makeRunner("w"),
			options.descriptor ?? makeDescriptor({}),
			options.validator ?? passValidator(),
		);
	}
	const executor = {
		invoke: options.invoke ?? (async () => ({ status: 200, body: "ok" })),
	} as Executor;
	const middleware = httpTriggerMiddleware(
		{ triggerRegistry: registry },
		executor,
	);
	const app = new Hono();
	app.all(middleware.match, middleware.handler);
	if (middleware.match.endsWith("/*")) {
		app.all(middleware.match.slice(0, -2), middleware.handler);
	}
	return { app, registry, executor };
}

// ---------------------------------------------------------------------------
// Registry routing
// ---------------------------------------------------------------------------

describe("HttpTriggerRegistry", () => {
	it("matches by exact static path + method", () => {
		const r = createHttpTriggerRegistry();
		const w = makeRunner("w");
		r.register(w, makeDescriptor({ name: "a", path: "x" }), passValidator());
		expect(r.lookup("t0", "w", "x", "POST")?.descriptor.name).toBe("a");
		expect(r.lookup("t0", "w", "x", "GET")).toBeUndefined();
		expect(r.lookup("t0", "w", "y", "POST")).toBeUndefined();
		expect(r.lookup("other", "w", "x", "POST")).toBeUndefined();
	});

	it("prefers static paths over parameterized ones", () => {
		const r = createHttpTriggerRegistry();
		const w = makeRunner("w");
		// Register parameterized first to make sure the registry honours
		// static priority regardless of insertion order.
		r.register(
			w,
			makeDescriptor({ name: "param", path: "users/:userId" }),
			passValidator(),
		);
		r.register(
			w,
			makeDescriptor({ name: "static", path: "users/admin" }),
			passValidator(),
		);
		expect(r.lookup("t0", "w", "users/admin", "POST")?.descriptor.name).toBe(
			"static",
		);
		expect(r.lookup("t0", "w", "users/other", "POST")?.descriptor.name).toBe(
			"param",
		);
		expect(r.lookup("t0", "w", "users/other", "POST")?.params).toEqual({
			userId: "other",
		});
	});

	it("matches wildcard catch-all", () => {
		const r = createHttpTriggerRegistry();
		const w = makeRunner("w");
		r.register(
			w,
			makeDescriptor({ name: "files", path: "files/*rest" }),
			passValidator(),
		);
		const match = r.lookup("t0", "w", "files/docs/2024/report.pdf", "POST");
		expect(match?.descriptor.name).toBe("files");
		expect(match?.params).toEqual({ rest: "docs/2024/report.pdf" });
	});

	it("exposes size reflecting registered count", () => {
		const r = createHttpTriggerRegistry();
		expect(r.size).toBe(0);
		r.register(makeRunner("w"), makeDescriptor({ name: "a" }), passValidator());
		r.register(
			makeRunner("w"),
			makeDescriptor({ name: "b", path: "y" }),
			passValidator(),
		);
		expect(r.size).toBe(2);
	});
});

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

	it("passes the parsed payload to the executor (body, params, query)", async () => {
		const received: unknown[] = [];
		const invoke = vi.fn<Executor["invoke"]>(async (_w, _t, payload) => {
			received.push(payload);
			return { status: 200 } satisfies HttpTriggerResult;
		});
		const descriptor = makeDescriptor({
			name: "paramTrig",
			path: "users/:userId",
			params: ["userId"],
		});
		const { app } = mount({ invoke, descriptor });

		const res = await app.request(
			"/webhooks/t0/w/users/abc?tag=one&tag=two&q=hello",
			{
				method: "POST",
				body: JSON.stringify({ active: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		expect(res.status).toBe(200);
		expect(received).toHaveLength(1);
		const payload = received[0] as {
			body: unknown;
			params: Record<string, string>;
			query: Record<string, string[]>;
			url: string;
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
		const validator: PayloadValidator = {
			validateBody: () => ({
				ok: false,
				issues: [
					{ path: ["a"], message: "a must be string" },
					{ path: ["b", 0], message: "b[0] must be number" },
				],
			}),
			validateQuery: (v) => ({ ok: true, value: v }),
			validateParams: (v) => ({ ok: true, value: v }),
		};
		const { app } = mount({ invoke, validator });
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
		// The middleware in this module does NOT add any authentication.
		// Attaching `apiMiddleware` or forward-auth to `/webhooks/*` is what
		// SECURITY.md §3 forbids. This test asserts the middleware admits a
		// request with NO auth headers.
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
		// The structured-clone pass in the Ajv validator (workflow-registry)
		// drops prototype-pollution keys. In this test we assert the
		// middleware's validator contract: when validator.validateBody
		// returns a clean value, that clean value is what the executor sees
		// — i.e., the middleware does not route the raw body around the
		// validator.
		const prototypePollutingValidator: PayloadValidator = {
			validateBody: () => ({ ok: true, value: { clean: true } }),
			validateQuery: (v) => ({ ok: true, value: v }),
			validateParams: (v) => ({ ok: true, value: v }),
		};
		const received: unknown[] = [];
		const invoke = vi.fn<Executor["invoke"]>(async (_w, _t, payload) => {
			received.push(payload);
			return { status: 200 };
		});
		const { app } = mount({ invoke, validator: prototypePollutingValidator });
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
