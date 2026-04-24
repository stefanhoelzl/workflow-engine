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
		method: "POST",
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
	readonly owner?: string;
}

async function mount(options: MountOptions = {}) {
	const source = createHttpTriggerSource();
	const owner = options.owner ?? "t0";
	if (options.entries) {
		await source.reconfigure(owner, options.entries);
	} else {
		await source.reconfigure(owner, [
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

	it("reconfigure replaces entries atomically for a owner", async () => {
		const d1 = makeDescriptor({ name: "a" });
		const d2 = makeDescriptor({ name: "b" });
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

	it("reconfigure for one owner does not affect another", async () => {
		const source = createHttpTriggerSource();
		await source.reconfigure("t0", [makeEntry(makeDescriptor({ name: "a" }))]);
		await source.reconfigure("t1", [makeEntry(makeDescriptor({ name: "b" }))]);
		await source.reconfigure("t0", []);
		const app = new Hono();
		app.all(source.middleware.match, source.middleware.handler);
		const t0Miss = await app.request("/webhooks/t0/w/a", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(t0Miss.status).toBe(404);
		const t1Hit = await app.request("/webhooks/t1/w/b", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(t1Hit.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Routing semantics — exact three-segment match
// ---------------------------------------------------------------------------

describe("createHttpTriggerSource: routing", () => {
	it("matches exactly on (owner, workflow, trigger-name) + method", async () => {
		const { app } = await mount({
			descriptor: makeDescriptor({ name: "webhook" }),
		});
		expect(
			(
				await app.request("/webhooks/t0/w/webhook", {
					method: "POST",
					body: "{}",
					headers: { "Content-Type": "application/json" },
				})
			).status,
		).toBe(200);
	});

	it("URL with four segments returns 404", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/t/extra", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(fire).not.toHaveBeenCalled();
	});

	it("URL with only two segments returns 404", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(fire).not.toHaveBeenCalled();
	});

	it("URL segment failing trigger-name regex returns 404", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/bad$name", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(fire).not.toHaveBeenCalled();
	});

	it("URL with hyphen in trigger-name segment returns 404 (regex rejects -)", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/has-hyphen", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(fire).not.toHaveBeenCalled();
	});

	it("method mismatch returns 404", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({
			fire,
			descriptor: makeDescriptor({ name: "webhook", method: "POST" }),
		});
		const res = await app.request("/webhooks/t0/w/webhook", { method: "GET" });
		expect(res.status).toBe(404);
		expect(fire).not.toHaveBeenCalled();
	});

	it("cross-owner request with matching workflow/trigger returns 404", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({
			fire,
			descriptor: makeDescriptor({ name: "webhook" }),
		});
		const res = await app.request("/webhooks/other/w/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(fire).not.toHaveBeenCalled();
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
		const res = await app.request("/webhooks/t0/w/t", {
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
		const res = await app.request("/webhooks/t0/w/t", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(201);
	});

	it("passes the normalized composite input (body/headers/url/method) to fire", async () => {
		const received: unknown[] = [];
		const { app } = await mount({
			fire: async (input) => {
				received.push(input);
				return { ok: true, output: { status: 200 } };
			},
		});
		const res = await app.request("/webhooks/t0/w/t", {
			method: "POST",
			body: JSON.stringify({ active: true }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		const payload = received[0] as {
			body: unknown;
			method: string;
			url: string;
			headers: Record<string, string>;
		};
		expect(payload.body).toEqual({ active: true });
		expect(payload.method).toBe("POST");
		expect(payload.url).toContain("/webhooks/t0/w/t");
		expect(Object.keys(payload).sort()).toEqual(
			["body", "headers", "method", "url"].sort(),
		);
	});

	it("query strings pass through unparsed in payload.url; no structured query field", async () => {
		const received: unknown[] = [];
		const { app } = await mount({
			fire: async (input) => {
				received.push(input);
				return { ok: true, output: { status: 200 } };
			},
		});
		const res = await app.request(
			"/webhooks/t0/w/t?delivery=abc&tag=one&tag=two",
			{
				method: "POST",
				body: "{}",
				headers: { "Content-Type": "application/json" },
			},
		);
		expect(res.status).toBe(200);
		const payload = received[0] as Record<string, unknown>;
		expect(payload.url).toContain("?delivery=abc&tag=one&tag=two");
		expect(payload.query).toBeUndefined();
		expect(payload.params).toBeUndefined();
		expect(Object.keys(payload).sort()).toEqual(
			["body", "headers", "method", "url"].sort(),
		);
	});

	it("returns 422 on non-JSON body", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/t0/w/t", {
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
		const res = await app.request("/webhooks/t0/w/t", {
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
		const res = await app.request("/webhooks/t0/w/t", {
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
	it("returns the installed TriggerEntry for (owner, workflow, trigger)", async () => {
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
		const res = await app.request("/webhooks/t0/w/t", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed owner names at the ingress", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({ fire });
		const res = await app.request("/webhooks/..%2Fevil/w/t", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(404);
		expect(fire).not.toHaveBeenCalled();
	});

	it("method-mismatch and unknown-trigger return the same 404 shape (no enumeration signal)", async () => {
		const fire = vi.fn<Fire>();
		const { app } = await mount({
			fire,
			descriptor: makeDescriptor({ name: "webhook", method: "POST" }),
		});
		const methodMismatch = await app.request("/webhooks/t0/w/webhook", {
			method: "GET",
		});
		const unknown = await app.request("/webhooks/t0/w/unknownName", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		expect(methodMismatch.status).toBe(404);
		expect(unknown.status).toBe(404);
	});

	it("a ?params=injected query string does not populate any structured field", async () => {
		const received: unknown[] = [];
		const { app } = await mount({
			fire: async (input) => {
				received.push(input);
				return { ok: true, output: { status: 200 } };
			},
		});
		const res = await app.request(
			"/webhooks/t0/w/t?params=injected&userId=evil",
			{
				method: "POST",
				body: "{}",
				headers: { "Content-Type": "application/json" },
			},
		);
		expect(res.status).toBe(200);
		const payload = received[0] as Record<string, unknown>;
		expect(payload.params).toBeUndefined();
		expect(payload.query).toBeUndefined();
	});
});
