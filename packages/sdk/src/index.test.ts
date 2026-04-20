import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACTION_BRAND,
	action,
	defineWorkflow,
	env,
	HTTP_TRIGGER_BRAND,
	httpTrigger,
	isAction,
	isHttpTrigger,
	isWorkflow,
	ManifestSchema,
	WORKFLOW_BRAND,
	z,
} from "./index.js";

const ACTION_NAME_MISSING_RE = /Action constructed without a name/;
const HOST_CALL_UNAVAILABLE_RE = /No action dispatcher installed/;

// ---------------------------------------------------------------------------
// Brand + type-guard tests
// ---------------------------------------------------------------------------

describe("brands and type guards", () => {
	it("action() returns a callable function branded with ACTION_BRAND", () => {
		const a = action({
			input: z.object({}),
			output: z.string(),
			handler: async () => "x",
			name: "a",
		});
		expect(typeof a).toBe("function");
		expect((a as unknown as Record<symbol, unknown>)[ACTION_BRAND]).toBe(true);
		expect(isAction(a)).toBe(true);
	});

	it("action exposes input, output as readable properties; handler is not a public property", () => {
		const input = z.object({ x: z.number() });
		const output = z.string();
		const handler = async ({ x }: { x: number }) => String(x);
		const a = action({ input, output, handler, name: "a" });
		expect(a.input).toBe(input);
		expect(a.output).toBe(output);
		expect(a.name).toBe("a");
		// No public `.handler` slot — guest code cannot bypass the dispatcher.
		expect((a as unknown as Record<string, unknown>).handler).toBeUndefined();
	});

	it("httpTrigger() returns a callable branded with HTTP_TRIGGER_BRAND", () => {
		const t = httpTrigger({
			path: "x",
			body: z.object({}),
			handler: async () => ({}),
		});
		expect(typeof t).toBe("function");
		expect((t as unknown as Record<symbol, unknown>)[HTTP_TRIGGER_BRAND]).toBe(
			true,
		);
		expect(isHttpTrigger(t)).toBe(true);
		// No public `.handler` slot — the callable IS the handler invocation path.
		expect((t as unknown as Record<string, unknown>).handler).toBeUndefined();
	});

	it("defineWorkflow() returns an object branded with WORKFLOW_BRAND", () => {
		const w = defineWorkflow();
		expect((w as unknown as Record<symbol, unknown>)[WORKFLOW_BRAND]).toBe(
			true,
		);
		expect(isWorkflow(w)).toBe(true);
	});

	it("isAction rejects a plain function", () => {
		expect(isAction(() => 1)).toBe(false);
	});

	it("isHttpTrigger rejects a plain object", () => {
		expect(isHttpTrigger({ path: "x" })).toBe(false);
	});

	it("isHttpTrigger rejects a plain callable without brand", () => {
		expect(isHttpTrigger(() => 1)).toBe(false);
	});

	it("isWorkflow rejects a plain object", () => {
		expect(isWorkflow({ name: "x" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Action callable
// ---------------------------------------------------------------------------

describe("action callable: host bridge + in-sandbox handler", () => {
	let hostCallMock: ReturnType<typeof vi.fn>;
	const globalRef = globalThis as Record<string, unknown>;

	beforeEach(() => {
		// The SDK delegates to globalThis.__dispatchAction (installed by the
		// runtime). Install the same dispatch shape used in production so the
		// SDK callable runs the host bridge → handler → output-parse pipeline.
		hostCallMock = vi.fn();
		globalRef.__hostCallAction = hostCallMock;
		globalRef.__dispatchAction = async (
			name: string,
			input: unknown,
			handler: (input: unknown) => Promise<unknown>,
			outputSchema: { parse(data: unknown): unknown },
		) => {
			await (hostCallMock as (n: string, i: unknown) => Promise<unknown>)(
				name,
				input,
			);
			const raw = await handler(input);
			return outputSchema.parse(raw);
		};
	});

	afterEach(() => {
		globalRef.__hostCallAction = undefined;
		globalRef.__dispatchAction = undefined;
	});

	it("notifies the host, then runs the handler, then returns the validated output", async () => {
		hostCallMock.mockResolvedValue(undefined);
		const handler = vi.fn(async ({ x }: { x: number }) => String(x));
		const a = action({
			input: z.object({ x: z.number() }),
			output: z.string(),
			handler,
			name: "sendNotification",
		});

		const result = await a({ x: 42 });

		expect(result).toBe("42");

		// Host bridge: called once with the assigned name + input.
		expect(hostCallMock).toHaveBeenCalledTimes(1);
		expect(hostCallMock).toHaveBeenCalledWith("sendNotification", { x: 42 });

		// Handler: runs in-sandbox (same JS context) with the input.
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith({ x: 42 });

		// Ordering: host bridge is called before the handler runs.
		const hostOrder = hostCallMock.mock.invocationCallOrder[0] ?? 0;
		const handlerOrder = handler.mock.invocationCallOrder[0] ?? 0;
		expect(hostOrder).toBeLessThan(handlerOrder);
	});

	it("skips the handler when the host bridge throws (input validation failure)", async () => {
		const boom = new Error("payload_validation_failed");
		hostCallMock.mockRejectedValue(boom);
		const handler = vi.fn(async () => "x");
		const a = action({
			input: z.object({ x: z.number() }),
			output: z.string(),
			handler,
			name: "sendNotification",
		});

		await expect(a({ x: "bad" } as any)).rejects.toThrow(
			"payload_validation_failed",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("validates the handler's output and rejects when it does not match the output schema", async () => {
		hostCallMock.mockResolvedValue(undefined);
		const handler = vi.fn(async () => 42 as unknown as string);
		const a = action({
			input: z.unknown(),
			output: z.string(),
			handler,
			name: "bad",
		});

		await expect(a(undefined)).rejects.toThrow();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("throws when invoked without a name; handler MUST NOT run", async () => {
		const handler = vi.fn(async () => undefined);
		const a = action({
			input: z.unknown(),
			output: z.unknown(),
			handler,
		});
		await expect(a(undefined)).rejects.toThrow(ACTION_NAME_MISSING_RE);
		expect(handler).not.toHaveBeenCalled();
	});

	it("dispatches with the configured name", async () => {
		hostCallMock.mockResolvedValue(undefined);
		const handler = vi.fn(async () => "ok");
		const a = action({
			input: z.unknown(),
			output: z.string(),
			handler,
			name: "myAction",
		});
		await a(undefined);
		expect(hostCallMock).toHaveBeenCalledWith("myAction", undefined);
	});
});

describe("action callable without sandbox globals", () => {
	const globalRef = globalThis as Record<string, unknown>;

	beforeEach(() => {
		globalRef.__hostCallAction = undefined;
		globalRef.__dispatchAction = undefined;
	});

	it("throws when invoked outside the sandbox (no dispatcher) — handler MUST NOT run", async () => {
		const handler = vi.fn(async () => undefined);
		const a = action({
			input: z.unknown(),
			output: z.unknown(),
			handler,
			name: "x",
		});
		await expect(a(undefined)).rejects.toThrow(HOST_CALL_UNAVAILABLE_RE);
		expect(handler).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// defineWorkflow / env resolution
// ---------------------------------------------------------------------------

describe("defineWorkflow", () => {
	it("returns an object with name and empty env when no config is given", () => {
		const w = defineWorkflow();
		expect(w.name).toBeUndefined();
		expect(w.env).toEqual({});
	});

	it("captures the explicit name", () => {
		const w = defineWorkflow({ name: "cronitor" });
		expect(w.name).toBe("cronitor");
	});

	it("freezes env so it is immutable", () => {
		const w = defineWorkflow({
			name: "x",
			env: { A: "hello" },
			envSource: {},
		});
		expect(Object.isFrozen(w.env)).toBe(true);
	});

	it("accepts plain string env values", () => {
		const w = defineWorkflow({
			name: "x",
			env: { A: "hello" },
			envSource: {},
		});
		expect(w.env.A).toBe("hello");
	});
});

describe("env() resolution", () => {
	it("resolves env ref using the key as the default name", () => {
		const w = defineWorkflow({
			env: { API_KEY: env() },
			envSource: { API_KEY: "abc" },
		});
		expect(w.env.API_KEY).toBe("abc");
	});

	it("resolves env ref with an explicit name", () => {
		const w = defineWorkflow({
			env: { url: env({ name: "MY_URL" }) },
			envSource: { MY_URL: "https://example.com" },
		});
		expect(w.env.url).toBe("https://example.com");
	});

	it("falls back to default when the env var is missing", () => {
		const w = defineWorkflow({
			env: { URL: env({ default: "https://x" }) },
			envSource: {},
		});
		expect(w.env.URL).toBe("https://x");
	});

	it("prefers env source over default", () => {
		const w = defineWorkflow({
			env: { URL: env({ default: "https://x" }) },
			envSource: { URL: "https://y" },
		});
		expect(w.env.URL).toBe("https://y");
	});

	it("throws when env var is missing and no default is provided", () => {
		expect(() => {
			defineWorkflow({
				env: { API_KEY: env() },
				envSource: {},
			});
		}).toThrow("Missing environment variable: API_KEY");
	});

	it("uses the explicit name in the missing-var error", () => {
		expect(() => {
			defineWorkflow({
				env: { url: env({ name: "MY_URL" }) },
				envSource: {},
			});
		}).toThrow("Missing environment variable: MY_URL");
	});
});

// ---------------------------------------------------------------------------
// httpTrigger defaults + shape
// ---------------------------------------------------------------------------

describe("httpTrigger defaults", () => {
	it("defaults method to POST when omitted", () => {
		const t = httpTrigger({
			path: "x",
			handler: async () => ({}),
		});
		expect(t.method).toBe("POST");
	});

	it("respects an explicit method override", () => {
		const t = httpTrigger({
			path: "x",
			method: "GET",
			handler: async () => ({}),
		});
		expect(t.method).toBe("GET");
	});

	it("defaults body to z.unknown() when omitted", () => {
		const t = httpTrigger({
			path: "x",
			handler: async () => ({}),
		});
		// z.unknown() accepts anything, including undefined.
		expect(t.body.safeParse(undefined).success).toBe(true);
		expect(t.body.safeParse("arbitrary").success).toBe(true);
	});

	it("uses the provided body schema", () => {
		const body = z.object({ orderId: z.string() });
		const t = httpTrigger({
			path: "x",
			body,
			handler: async () => ({}),
		});
		expect(t.body).toBe(body);
	});

	it("exposes path as a readonly property and invokes the handler when called", async () => {
		const handler = vi.fn(async () => ({ status: 202 }));
		const t = httpTrigger({
			path: "orders/:orderId",
			handler,
		});
		expect(t.path).toBe("orders/:orderId");
		const result = await t({
			body: undefined,
			headers: {},
			url: "/orders/1",
			method: "POST",
			params: { orderId: "1" } as any,
			query: {} as any,
		});
		expect(result).toEqual({ status: 202 });
		expect(handler).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// ManifestSchema (v1)
// ---------------------------------------------------------------------------

describe("ManifestSchema", () => {
	const validWorkflow = {
		name: "cronitor",
		module: "cronitor.js",
		sha: "0".repeat(64),
		env: { URL: "https://example.com" },
		actions: [
			{
				name: "sendNotification",
				input: { type: "object" },
				output: { type: "object" },
			},
		],
		triggers: [
			{
				name: "onCronitorEvent",
				type: "http",
				path: "cronitor",
				method: "POST",
				body: { type: "object" },
				params: [],
				inputSchema: { type: "object" },
				outputSchema: { type: "object" },
			},
		],
	};

	const validManifest = { workflows: [validWorkflow] };

	it("accepts a valid v1 tenant manifest", () => {
		const parsed = ManifestSchema.parse(validManifest);
		expect(parsed.workflows).toHaveLength(1);
		const wf = parsed.workflows[0];
		expect(wf?.name).toBe("cronitor");
		expect(wf?.module).toBe("cronitor.js");
		expect(wf?.actions).toHaveLength(1);
		expect(wf?.triggers).toHaveLength(1);
	});

	it("accepts an HTTP trigger with an optional query JSON Schema", () => {
		const parsed = ManifestSchema.parse({
			workflows: [
				{
					...validWorkflow,
					triggers: [
						{
							name: "search",
							type: "http",
							path: "search",
							method: "GET",
							body: { type: "object" },
							params: [],
							query: { type: "object" },
							inputSchema: { type: "object" },
							outputSchema: { type: "object" },
						},
					],
				},
			],
		});
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "http") {
			throw new Error("expected http trigger");
		}
		expect(trigger.query).toEqual({ type: "object" });
	});

	it("rejects a tenant manifest missing the workflows array", () => {
		expect(() => ManifestSchema.parse({})).toThrow();
	});

	it("rejects a workflow entry missing the name field", () => {
		const { name: _name, ...rest } = validWorkflow;
		expect(() => ManifestSchema.parse({ workflows: [rest] })).toThrow();
	});

	it("rejects a workflow entry missing the module field", () => {
		const { module: _module, ...rest } = validWorkflow;
		expect(() => ManifestSchema.parse({ workflows: [rest] })).toThrow();
	});

	it("rejects a workflow entry missing the actions field", () => {
		const { actions: _actions, ...rest } = validWorkflow;
		expect(() => ManifestSchema.parse({ workflows: [rest] })).toThrow();
	});

	it("rejects duplicate workflow names within one tenant manifest", () => {
		expect(() =>
			ManifestSchema.parse({
				workflows: [validWorkflow, validWorkflow],
			}),
		).toThrow();
	});

	it("rejects an action entry without input", () => {
		expect(() =>
			ManifestSchema.parse({
				workflows: [
					{
						...validWorkflow,
						actions: [
							{
								name: "broken",
								output: { type: "object" },
							},
						],
					},
				],
			}),
		).toThrow();
	});

	it("rejects an action entry without output", () => {
		expect(() =>
			ManifestSchema.parse({
				workflows: [
					{
						...validWorkflow,
						actions: [
							{
								name: "broken",
								input: { type: "object" },
							},
						],
					},
				],
			}),
		).toThrow();
	});

	it("rejects a trigger without type discriminator", () => {
		expect(() =>
			ManifestSchema.parse({
				workflows: [
					{
						...validWorkflow,
						triggers: [
							{
								name: "noType",
								path: "x",
								method: "POST",
								body: { type: "object" },
								params: [],
							},
						],
					},
				],
			}),
		).toThrow();
	});

	it("rejects a trigger with an unknown type discriminator", () => {
		expect(() =>
			ManifestSchema.parse({
				workflows: [
					{
						...validWorkflow,
						triggers: [
							{
								name: "unknownKind",
								type: "queue",
								path: "x",
								method: "POST",
								body: { type: "object" },
								params: [],
							},
						],
					},
				],
			}),
		).toThrow();
	});

	it("strips legacy fields like events from the parsed shape", () => {
		const parsed = ManifestSchema.parse({
			...validManifest,
			events: [{ name: "ignored", schema: { type: "object" } }],
		});
		expect(parsed).not.toHaveProperty("events");
	});
});
