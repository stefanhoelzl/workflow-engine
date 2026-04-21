import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HttpTriggerDescriptor, InvokeResult } from "../executor/types.js";
import { createHttpTriggerSource } from "./http.js";
import type { TriggerEntry } from "./source.js";
import { validate } from "./validator.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDescriptor(
	overrides: Partial<HttpTriggerDescriptor> = {},
): HttpTriggerDescriptor {
	return {
		kind: "http",
		type: "http",
		name: "t",
		workflowName: "w",
		path: "webhook",
		method: "POST",
		params: [],
		body: { type: "object" },
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		...overrides,
	};
}

type Fire = (input: unknown) => Promise<InvokeResult<unknown>>;

function makeEntry(
	descriptor: HttpTriggerDescriptor,
	fire?: Fire,
): TriggerEntry<HttpTriggerDescriptor> & { fire: ReturnType<typeof vi.fn> } {
	const fireMock = vi.fn<Fire>(
		fire ??
			(async () => ({
				ok: true as const,
				output: { status: 200, body: "ok" },
			})),
	);
	return { descriptor, fire: fireMock };
}

// fire closure that runs the real input-schema validator, mirroring the
// production registry-built closure. Used where tests want to assert
// HTTP-level responses to validation failure.
function validatingFire(
	descriptor: HttpTriggerDescriptor,
	onValid: (input: unknown) => Promise<InvokeResult<unknown>>,
): Fire {
	return async (input) => {
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
		return onValid(v.input);
	};
}

interface MountOptions {
	readonly descriptor?: HttpTriggerDescriptor;
	readonly entries?: readonly TriggerEntry<HttpTriggerDescriptor>[];
	readonly fire?: Fire;
	readonly tenant?: string;
}

async function mount(options: MountOptions = {}) {
	const source = createHttpTriggerSource();
	const tenant = options.tenant ?? "t0";
	if (options.entries) {
		await source.reconfigure(tenant, options.entries);
	} else {
		await source.reconfigure(tenant, [
			makeEntry(options.descriptor ?? makeDescriptor(), options.fire),
		]);
	}
	const app = new Hono();
	app.all(source.middleware.match, source.middleware.handler);
	if (source.middleware.match.endsWith("/*")) {
		app.all(source.middleware.match.slice(0, -2), source.middleware.handler);
	}
	return { app, source };
}

// ---------------------------------------------------------------------------
// TriggerSource contract
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: contract", () => {
	it("exposes kind=http and a middleware with /webhooks/* match", () => {
		const source = createHttpTriggerSource();
		expect(source.kind).toBe("http");
		expect(source.middleware.match).toBe("/webhooks/*");
	});

	it("start() and stop() are idempotent no-ops", async () => {
		const source = createHttpTriggerSource();
		await source.start();
		await source.start();
		await source.stop();
		await source.stop();
	});

	it("reconfigure replaces entries atomically for a tenant", async () => {
		const d1 = makeDescriptor({ name: "a", path: "a" });
		const d2 = makeDescriptor({ name: "b", path: "b" });
		const source = createHttpTriggerSource();
		await source.reconfigure("t0", [makeEntry(d1)]);
		await source.reconfigure("t0", [makeEntry(d2)]);
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

	it("reconfigure for one tenant does not affect another", async () => {
		const source = createHttpTriggerSource();
		await source.reconfigure("t0", [makeEntry(makeDescriptor({ name: "a" }))]);
		await source.reconfigure("t1", [makeEntry(makeDescriptor({ name: "b" }))]);
		// Clear t0.
		await source.reconfigure("t0", []);
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		const t0Miss = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(t0Miss.status).toBe(404);
		const t1Hit = await app.request("/webhooks/t1/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(t1Hit.status).toBe(200);
	});

	it("reconfigure returns {ok: false, errors} on duplicate HTTP route within a workflow", async () => {
		const source = createHttpTriggerSource();
		const d1 = makeDescriptor({ name: "a", path: "dup", method: "POST" });
		const d2 = makeDescriptor({ name: "b", path: "dup", method: "POST" });
		const result = await source.reconfigure("t0", [
			makeEntry(d1),
			makeEntry(d2),
		]);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected failure");
		}
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]?.backend).toBe("http");
	});
});

// ---------------------------------------------------------------------------
// Routing semantics
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: routing", () => {
	it("matches by exact static path + method", async () => {
		const { app } = await mount({
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
		const { app } = await mount({
			entries: [
				makeEntry(makeDescriptor({ name: "param", path: "users/:userId" })),
				makeEntry(makeDescriptor({ name: "static", path: "users/admin" })),
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

	it("matches wildcard catch-all and passes params to fire", async () => {
		const received: unknown[] = [];
		const { app } = await mount({
			descriptor: makeDescriptor({ name: "files", path: "files/*rest" }),
			fire: async (input) => {
				received.push(input);
				return { ok: true, output: { status: 200 } };
			},
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
	it("calls entry.fire and serializes the output as the HTTP response", async () => {
		const fire = vi.fn<Fire>(async () => ({
			ok: true,
			output: {
				status: 202,
				body: { ok: true },
				headers: { "X-Custom": "v" },
			},
		}));
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({ x: 1 }),
			headers: { "Content-Type": "application/json" },
		});
		expect(fire).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(202);
		expect(res.headers.get("X-Custom")).toBe("v");
		expect(await res.json()).toEqual({ ok: true });
	});

	it("applies defaults when handler returns only a status", async () => {
		const fire = vi.fn<Fire>(async () => ({
			ok: true,
			output: { status: 201 },
		}));
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(201);
	});

	it("passes the normalized composite input to fire", async () => {
		const received: unknown[] = [];
		const descriptor = makeDescriptor({
			name: "paramTrig",
			path: "users/:userId",
			params: ["userId"],
		});
		const { app } = await mount({
			descriptor,
			fire: async (input) => {
				received.push(input);
				return { ok: true, output: { status: 200 } };
			},
		});
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
		const fire = vi.fn<Fire>();
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{not json",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(422);
		expect(fire).not.toHaveBeenCalled();
	});

	it("returns 422 when fire reports input-schema validation failure", async () => {
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
		const onValid = vi.fn<Fire>();
		const { app } = await mount({
			descriptor,
			fire: validatingFire(descriptor, onValid),
		});
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({ x: "not-a-number" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(422);
		expect(onValid).not.toHaveBeenCalled();
	});

	it("returns 500 when fire reports a non-validation failure", async () => {
		const fire = vi.fn<Fire>(async () => ({
			ok: false,
			error: { message: "boom" },
		}));
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "internal_error" });
	});

	it("returns 404 when no trigger matches", async () => {
		const source = createHttpTriggerSource();
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: webhooks health probe", () => {
	it("returns 503 when no trigger is registered", async () => {
		const source = createHttpTriggerSource();
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		app.all(source.middleware.match.slice(0, -2), source.middleware.handler);
		const res = await app.request("/webhooks/", { method: "GET" });
		expect(res.status).toBe(503);
	});

	it("returns 204 when at least one trigger is registered", async () => {
		const { source } = await mount({});
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		app.all(source.middleware.match.slice(0, -2), source.middleware.handler);
		const res = await app.request("/webhooks/", { method: "GET" });
		expect(res.status).toBe(204);
	});
});

// ---------------------------------------------------------------------------
// getEntry accessor (manual-fire UI)
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: getEntry", () => {
	it("returns the installed TriggerEntry for (tenant, workflow, trigger)", async () => {
		const d = makeDescriptor({ name: "a", workflowName: "w" });
		const entry = makeEntry(d);
		const source = createHttpTriggerSource();
		await source.reconfigure("t0", [entry]);
		expect(source.getEntry("t0", "w", "a")).toBe(entry);
		expect(source.getEntry("t0", "w", "missing")).toBeUndefined();
		expect(source.getEntry("t1", "w", "a")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: security", () => {
	it("is a public ingress — no auth middleware attached (per SECURITY.md §3)", async () => {
		const fire = vi.fn<Fire>(async () => ({
			ok: true,
			output: { status: 200 },
		}));
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/webhook", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed tenant names at the ingress", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/..%2Fevil/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(fire).not.toHaveBeenCalled();
	});
});
