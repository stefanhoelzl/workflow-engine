import type { WorkflowManifest } from "@workflow-engine/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor/index.js";
import type { HttpTriggerDescriptor } from "../executor/types.js";
import { createHttpTriggerSource } from "./http.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWorkflow(name = "w"): WorkflowManifest {
	return {
		name,
		module: `${name}.js`,
		sha: "0".repeat(64),
		env: {},
		actions: [],
		triggers: [],
	};
}

function makeDescriptor(
	overrides: Partial<HttpTriggerDescriptor> = {},
): HttpTriggerDescriptor {
	return {
		kind: "http",
		type: "http",
		name: "t",
		path: "webhook",
		method: "POST",
		params: [],
		body: { type: "object" },
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		...overrides,
	};
}

interface MountOptions {
	readonly descriptor?: HttpTriggerDescriptor;
	readonly descriptors?: {
		readonly tenant: string;
		readonly workflow: WorkflowManifest;
		readonly bundleSource: string;
		readonly descriptor: HttpTriggerDescriptor;
	}[];
	readonly invoke?: Executor["invoke"];
	readonly tenant?: string;
}

function mount(options: MountOptions = {}) {
	const executor = {
		invoke:
			options.invoke ??
			(async () => ({
				ok: true as const,
				output: { status: 200, body: "ok" },
			})),
	} as Executor;
	const source = createHttpTriggerSource({ executor });
	if (options.descriptors) {
		source.reconfigure(options.descriptors);
	} else {
		source.reconfigure([
			{
				tenant: options.tenant ?? "t0",
				workflow: makeWorkflow(),
				bundleSource: "source",
				descriptor: options.descriptor ?? makeDescriptor(),
			},
		]);
	}
	const app = new Hono();
	app.all(source.middleware.match, source.middleware.handler);
	if (source.middleware.match.endsWith("/*")) {
		app.all(source.middleware.match.slice(0, -2), source.middleware.handler);
	}
	return { app, source, executor };
}

// ---------------------------------------------------------------------------
// TriggerSource contract
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: contract", () => {
	it("exposes kind=http and a middleware with /webhooks/* match", () => {
		const source = createHttpTriggerSource({
			executor: { invoke: vi.fn() } as unknown as Executor,
		});
		expect(source.kind).toBe("http");
		expect(source.middleware.match).toBe("/webhooks/*");
	});

	it("start() and stop() are idempotent no-ops", async () => {
		const source = createHttpTriggerSource({
			executor: { invoke: vi.fn() } as unknown as Executor,
		});
		await source.start();
		await source.start();
		await source.stop();
		await source.stop();
	});

	it("reconfigure replaces entries atomically", async () => {
		const w = makeWorkflow();
		const d1 = makeDescriptor({ name: "a", path: "a" });
		const d2 = makeDescriptor({ name: "b", path: "b" });
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true,
			output: { status: 200 },
		}));
		const source = createHttpTriggerSource({
			executor: { invoke } as Executor,
		});
		source.reconfigure([
			{ tenant: "t0", workflow: w, bundleSource: "s", descriptor: d1 },
		]);
		source.reconfigure([
			{ tenant: "t0", workflow: w, bundleSource: "s", descriptor: d2 },
		]);
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		const miss = await app.request("/webhooks/t0/w/a", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(miss.status).toBe(404);
		const hit = await app.request("/webhooks/t0/w/b", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(hit.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Routing semantics
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: routing", () => {
	it("matches by exact static path + method", async () => {
		const { app } = mount({
			descriptor: makeDescriptor({ name: "a", path: "x" }),
		});
		expect(
			(
				await app.request("/webhooks/t0/w/x", {
					method: "POST",
					body: "{}",
					headers: { "Content-Type": "application/json" },
				})
			).status,
		).toBe(200);
		expect(
			(await app.request("/webhooks/t0/w/x", { method: "GET" })).status,
		).toBe(404);
		expect(
			(
				await app.request("/webhooks/t0/w/y", {
					method: "POST",
					body: "{}",
					headers: { "Content-Type": "application/json" },
				})
			).status,
		).toBe(404);
		expect(
			(
				await app.request("/webhooks/other/w/x", {
					method: "POST",
					body: "{}",
					headers: { "Content-Type": "application/json" },
				})
			).status,
		).toBe(404);
	});

	it("prefers static paths over parameterized ones", async () => {
		const w = makeWorkflow();
		const { app } = mount({
			descriptors: [
				{
					tenant: "t0",
					workflow: w,
					bundleSource: "s",
					descriptor: makeDescriptor({ name: "param", path: "users/:userId" }),
				},
				{
					tenant: "t0",
					workflow: w,
					bundleSource: "s",
					descriptor: makeDescriptor({ name: "static", path: "users/admin" }),
				},
			],
		});
		expect(
			(
				await app.request("/webhooks/t0/w/users/admin", {
					method: "POST",
					body: "{}",
					headers: { "Content-Type": "application/json" },
				})
			).status,
		).toBe(200);
		expect(
			(
				await app.request("/webhooks/t0/w/users/other", {
					method: "POST",
					body: "{}",
					headers: { "Content-Type": "application/json" },
				})
			).status,
		).toBe(200);
	});

	it("matches wildcard catch-all and passes params to executor", async () => {
		const received: unknown[] = [];
		const invoke = vi.fn<Executor["invoke"]>(
			// biome-ignore lint/complexity/useMaxParams: Executor.invoke contract has 5 params; we bind only `input`
			async (_t, _w, _d, input, _b) => {
				received.push(input);
				return { ok: true, output: { status: 200 } };
			},
		);
		const { app } = mount({
			descriptor: makeDescriptor({ name: "files", path: "files/*rest" }),
			invoke,
		});
		const res = await app.request("/webhooks/t0/w/files/docs/2024/report.pdf", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		const input = received[0] as { params: Record<string, string> };
		expect(input.params.rest).toBe("docs/2024/report.pdf");
	});
});

// ---------------------------------------------------------------------------
// Dispatch + response shaping
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: dispatch", () => {
	it("invokes executor and serializes the output as the HTTP response", async () => {
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true,
			output: {
				status: 202,
				body: { ok: true },
				headers: { "X-Custom": "v" },
			},
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

	it("applies defaults when handler returns only a status", async () => {
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true,
			output: { status: 201 },
		}));
		const { app } = mount({ invoke });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(201);
	});

	it("passes the validated composite input to the executor", async () => {
		const received: unknown[] = [];
		const invoke = vi.fn<Executor["invoke"]>(
			// biome-ignore lint/complexity/useMaxParams: Executor.invoke contract has 5 params; we bind only `input`
			async (_t, _w, _d, input, _b) => {
				received.push(input);
				return { ok: true, output: { status: 200 } };
			},
		);
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
		const payload = received[0] as {
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

	it("returns 422 on non-JSON body", async () => {
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

	it("returns 422 when input fails descriptor.inputSchema validation", async () => {
		const descriptor = makeDescriptor({
			inputSchema: {
				type: "object",
				properties: {
					body: {
						type: "object",
						properties: { x: { type: "number" } },
						required: ["x"],
					},
				},
				required: ["body"],
			},
		});
		const invoke = vi.fn<Executor["invoke"]>();
		const { app } = mount({ invoke, descriptor });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({ x: "not-a-number" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(422);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("returns 500 on executor error sentinel", async () => {
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: false,
			error: { message: "boom" },
		}));
		const { app } = mount({ invoke });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "internal_error" });
	});

	it("returns 404 when no trigger matches", async () => {
		const invoke = vi.fn<Executor["invoke"]>();
		const source = createHttpTriggerSource({
			executor: { invoke } as Executor,
		});
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(invoke).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: webhooks health probe", () => {
	it("returns 503 when no trigger is registered", async () => {
		const source = createHttpTriggerSource({
			executor: { invoke: vi.fn() } as unknown as Executor,
		});
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		app.all(source.middleware.match.slice(0, -2), source.middleware.handler);
		const res = await app.request("/webhooks/", { method: "GET" });
		expect(res.status).toBe(503);
	});

	it("returns 204 when at least one trigger is registered", async () => {
		const { source } = mount({});
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		app.all(source.middleware.match.slice(0, -2), source.middleware.handler);
		const res = await app.request("/webhooks/", { method: "GET" });
		expect(res.status).toBe(204);
	});
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: security", () => {
	it("is a public ingress — no auth middleware attached (per SECURITY.md §3)", async () => {
		const invoke = vi.fn<Executor["invoke"]>(async () => ({
			ok: true,
			output: { status: 200 },
		}));
		const { app } = mount({ invoke });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed tenant names at the ingress", async () => {
		const invoke = vi.fn<Executor["invoke"]>();
		const { app } = mount({ invoke });
		const res = await app.request("/webhooks/..%2Fevil/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(invoke).not.toHaveBeenCalled();
	});
});
