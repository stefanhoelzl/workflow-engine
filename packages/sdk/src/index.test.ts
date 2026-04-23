import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACTION_BRAND,
	action,
	CRON_TRIGGER_BRAND,
	cronTrigger,
	defineWorkflow,
	env,
	HTTP_TRIGGER_BRAND,
	httpTrigger,
	isAction,
	isCronTrigger,
	isHttpTrigger,
	isManualTrigger,
	isWorkflow,
	MANUAL_TRIGGER_BRAND,
	ManifestSchema,
	manualTrigger,
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

	it("cronTrigger() returns a callable branded with CRON_TRIGGER_BRAND", () => {
		const t = cronTrigger({
			schedule: "0 9 * * *",
			tz: "UTC",
			handler: async () => {},
		});
		expect(typeof t).toBe("function");
		expect((t as unknown as Record<symbol, unknown>)[CRON_TRIGGER_BRAND]).toBe(
			true,
		);
		expect(isCronTrigger(t)).toBe(true);
		expect((t as unknown as Record<string, unknown>).handler).toBeUndefined();
	});

	it("cronTrigger exposes schedule, tz, inputSchema, outputSchema as readonly properties", () => {
		const t = cronTrigger({
			schedule: "*/5 * * * *",
			tz: "Europe/Berlin",
			handler: async () => {},
		});
		expect(t.schedule).toBe("*/5 * * * *");
		expect(t.tz).toBe("Europe/Berlin");
		expect(t.inputSchema).toBeDefined();
		expect(t.outputSchema).toBeDefined();
		expect(() => {
			(t as unknown as { schedule: string }).schedule = "hacked";
		}).toThrow();
	});

	it("cronTrigger defaults tz to the host IANA zone when omitted", () => {
		const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const t = cronTrigger({
			schedule: "0 0 * * *",
			handler: async () => {},
		});
		expect(t.tz).toBe(hostTz);
	});

	it("cronTrigger callable invokes the handler", async () => {
		const handler = vi.fn(async () => "ok" as unknown);
		const t = cronTrigger({
			schedule: "0 0 * * *",
			tz: "UTC",
			handler,
		});
		const result = await t();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(result).toBe("ok");
	});

	it("isCronTrigger rejects a plain function", () => {
		expect(isCronTrigger(() => 1)).toBe(false);
	});

	it("cronTrigger rejects invalid schedule strings at the type level", () => {
		// These assignments pass through the ts-cron-validator template-literal
		// type. `tsc --build` (run as part of `pnpm check` / `pnpm validate`)
		// would fail if any of the `@ts-expect-error` lines compiled cleanly.
		// @ts-expect-error "not-a-cron" is not a valid StandardCRON literal
		cronTrigger({ schedule: "not-a-cron", handler: async () => {} });
		// @ts-expect-error 6-field cron is non-standard
		cronTrigger({ schedule: "0 0 9 * * *", handler: async () => {} });
		// @ts-expect-error minute out of range
		cronTrigger({ schedule: "60 9 * * *", handler: async () => {} });
		// @ts-expect-error too few fields
		cronTrigger({ schedule: "0 9 * *", handler: async () => {} });
	});

	it("isCronTrigger distinguishes from httpTrigger", () => {
		const http = httpTrigger({
			handler: async () => ({}),
		});
		expect(isCronTrigger(http)).toBe(false);
		const cron = cronTrigger({
			schedule: "0 0 * * *",
			tz: "UTC",
			handler: async () => {},
		});
		expect(isHttpTrigger(cron)).toBe(false);
	});

	it("manualTrigger() returns a callable branded with MANUAL_TRIGGER_BRAND", () => {
		const t = manualTrigger({ handler: async () => "ok" });
		expect(typeof t).toBe("function");
		expect(
			(t as unknown as Record<symbol, unknown>)[MANUAL_TRIGGER_BRAND],
		).toBe(true);
		expect(isManualTrigger(t)).toBe(true);
	});

	it("manualTrigger exposes inputSchema and outputSchema as readonly properties", () => {
		const input = z.object({ id: z.string() });
		const output = z.object({ ok: z.boolean() });
		const t = manualTrigger({
			input,
			output,
			handler: async () => ({ ok: true }),
		});
		expect(t.inputSchema).toBe(input);
		expect(t.outputSchema).toBe(output);
		// No public `.handler` slot — guest/build code cannot read it.
		expect((t as unknown as Record<string, unknown>).handler).toBeUndefined();
	});

	it("manualTrigger defaults inputSchema to z.object({}) and outputSchema to z.unknown()", () => {
		const t = manualTrigger({ handler: async () => {} });
		// Defaults should parse the corresponding shapes without throwing.
		expect(() => t.inputSchema.parse({})).not.toThrow();
		expect(() => t.outputSchema.parse(42)).not.toThrow();
	});

	it("manualTrigger callable invokes the handler with the input", async () => {
		const calls: unknown[] = [];
		const t = manualTrigger({
			input: z.object({ id: z.string() }),
			handler: async (input) => {
				calls.push(input);
				return input.id;
			},
		});
		const out = await t({ id: "abc" });
		expect(out).toBe("abc");
		expect(calls).toEqual([{ id: "abc" }]);
	});

	it("isManualTrigger rejects plain values and distinguishes from http/cron", () => {
		expect(isManualTrigger(() => 1)).toBe(false);
		expect(isManualTrigger(null)).toBe(false);
		expect(isManualTrigger({})).toBe(false);
		const http = httpTrigger({ handler: async () => ({}) });
		const cron = cronTrigger({
			schedule: "0 0 * * *",
			tz: "UTC",
			handler: async () => {},
		});
		const manual = manualTrigger({ handler: async () => {} });
		expect(isManualTrigger(http)).toBe(false);
		expect(isManualTrigger(cron)).toBe(false);
		expect(isHttpTrigger(manual)).toBe(false);
		expect(isCronTrigger(manual)).toBe(false);
	});

	it("manualTrigger throws when handler is omitted", () => {
		expect(() =>
			// @ts-expect-error — missing handler
			manualTrigger({}),
		).toThrow(/missing a handler/);
	});
});

// ---------------------------------------------------------------------------
// Action callable
// ---------------------------------------------------------------------------

describe("action callable: host bridge + in-sandbox handler", () => {
	let hostCallMock: ReturnType<typeof vi.fn>;
	const globalRef = globalThis as Record<string, unknown>;

	beforeEach(() => {
		// The SDK delegates to globalThis.__sdk.dispatchAction (installed by the
		// sdk-support plugin). Install the same dispatch shape used in
		// production: the plugin validates input host-side, runs the guest
		// handler, then validates output host-side. Output validation is NOT
		// performed by the SDK; this mock simulates a passthrough host
		// validator that accepts any value.
		hostCallMock = vi.fn();
		globalRef.__sdk = Object.freeze({
			dispatchAction: async (
				name: string,
				input: unknown,
				handler: (input: unknown) => Promise<unknown>,
			) => {
				await (hostCallMock as (n: string, i: unknown) => Promise<unknown>)(
					name,
					input,
				);
				return handler(input);
			},
		});
	});

	afterEach(() => {
		globalRef.__sdk = undefined;
	});

	it("notifies the host, then runs the handler, then returns the handler's output (host-side validation runs inside the dispatcher)", async () => {
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

	it("relies on the host-side dispatcher for output validation (SDK does not parse output itself)", async () => {
		// Simulate the host-side validator rejecting a mismatched output.
		const outputErr = new Error("output validation: /: must be string");
		globalRef.__sdk = Object.freeze({
			dispatchAction: async (
				_name: string,
				input: unknown,
				handler: (input: unknown) => Promise<unknown>,
			) => {
				await handler(input);
				throw outputErr;
			},
		});
		const handler = vi.fn(async () => 42 as unknown as string);
		const a = action({
			input: z.unknown(),
			output: z.string(),
			handler,
			name: "bad",
		});

		await expect(a(undefined)).rejects.toThrow(/output validation/);
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

	it("invokes __sdk.dispatchAction with exactly three positional args: (name, input, handler)", async () => {
		const dispatchSpy = vi.fn(
			async (
				_name: string,
				_input: unknown,
				handler: (input: unknown) => Promise<unknown>,
			) => handler(_input),
		);
		globalRef.__sdk = Object.freeze({ dispatchAction: dispatchSpy });
		const handler = vi.fn(async ({ x }: { x: number }) => x * 2);
		const a = action({
			input: z.object({ x: z.number() }),
			output: z.number(),
			handler,
			name: "double",
		});
		const result = await a({ x: 21 });
		expect(result).toBe(42);
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		const call = dispatchSpy.mock.calls[0];
		expect(call?.length).toBe(3);
		expect(call?.[0]).toBe("double");
		expect(call?.[1]).toEqual({ x: 21 });
		expect(typeof call?.[2]).toBe("function");
		// No fourth positional argument: output validation lives host-side,
		// the guest no longer supplies a completer closure.
		expect((call as unknown[] | undefined)?.[3]).toBeUndefined();
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
		globalRef.__sdk = undefined;
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
			handler: async () => ({}),
		});
		expect(t.method).toBe("POST");
	});

	it("respects an explicit method override", () => {
		const t = httpTrigger({
			method: "GET",
			handler: async () => ({}),
		});
		expect(t.method).toBe("GET");
	});

	it("defaults body to z.unknown() when omitted", () => {
		const t = httpTrigger({
			handler: async () => ({}),
		});
		// z.unknown() accepts anything, including undefined.
		expect(t.body.safeParse(undefined).success).toBe(true);
		expect(t.body.safeParse("arbitrary").success).toBe(true);
	});

	it("uses the provided body schema", () => {
		const body = z.object({ orderId: z.string() });
		const t = httpTrigger({
			body,
			handler: async () => ({}),
		});
		expect(t.body).toBe(body);
	});

	it("invokes the handler when called with the composite payload", async () => {
		const handler = vi.fn(async () => ({ status: 202 }));
		const t = httpTrigger({
			handler,
		});
		const result = await t({
			body: undefined,
			headers: {},
			url: "/webhooks/t/w/x",
			method: "POST",
		});
		expect(result).toEqual({ status: 202 });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("does not expose path, params, or query as properties", () => {
		const t = httpTrigger({
			handler: async () => ({}),
		});
		expect((t as unknown as Record<string, unknown>).path).toBeUndefined();
		expect((t as unknown as Record<string, unknown>).params).toBeUndefined();
		expect((t as unknown as Record<string, unknown>).query).toBeUndefined();
	});

	it("default outputSchema is strict (envelope-only, additionalProperties: false, all optional)", () => {
		const t = httpTrigger({ handler: async () => ({}) });
		const json = z.toJSONSchema(t.outputSchema) as Record<string, unknown>;
		expect(json.additionalProperties).toBe(false);
		expect(json.required).toBeUndefined();
		const props = json.properties as Record<string, unknown>;
		expect(props.status).toBeDefined();
		expect(props.body).toBeDefined();
		expect(props.headers).toBeDefined();
	});

	it("declaring responseBody makes body required and strict at the envelope", () => {
		const responseBody = z.object({ orderId: z.string() });
		const t = httpTrigger({
			responseBody,
			handler: async () => ({ body: { orderId: "x" } }),
		});
		const json = z.toJSONSchema(t.outputSchema) as Record<string, unknown>;
		expect(json.additionalProperties).toBe(false);
		expect(json.required).toEqual(["body"]);
		const bodyProp = (json.properties as Record<string, unknown>).body as
			| Record<string, unknown>
			| undefined;
		expect(bodyProp?.type).toBe("object");
		expect((bodyProp?.properties as Record<string, unknown>)?.orderId).toEqual({
			type: "string",
		});
		expect(bodyProp?.required).toEqual(["orderId"]);
		// body of the declared schema inherits Zod's strict default.
		expect(bodyProp?.additionalProperties).toBe(false);
	});

	it("TypeScript narrows the handler return type when responseBody is declared", () => {
		// Compile-time assertion only: when `responseBody` is declared, the
		// handler return type requires `body`. A handler returning `{status: 202}`
		// without `body` fails TS at compile time. We assert the positive case
		// compiles; the negative case is enforced by TypeScript.
		const t = httpTrigger({
			responseBody: z.object({ orderId: z.string() }),
			handler: async () => ({ status: 202, body: { orderId: "x" } }),
		});
		expect(t.method).toBe("POST");
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
				method: "POST",
				body: { type: "object" },
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

	it("strips a legacy path field from an HTTP trigger entry (z.object default)", () => {
		const parsed = ManifestSchema.parse({
			workflows: [
				{
					...validWorkflow,
					triggers: [
						{
							name: "legacy",
							type: "http",
							path: "legacy",
							method: "POST",
							body: { type: "object" },
							inputSchema: { type: "object" },
							outputSchema: { type: "object" },
						},
					],
				},
			],
		});
		const trigger = parsed.workflows[0]?.triggers[0];
		expect(trigger).toBeDefined();
		expect((trigger as Record<string, unknown>).path).toBeUndefined();
		expect((trigger as Record<string, unknown>).params).toBeUndefined();
	});

	it("rejects an HTTP trigger whose name fails the identifier regex", () => {
		expect(() =>
			ManifestSchema.parse({
				workflows: [
					{
						...validWorkflow,
						triggers: [
							{
								name: "$weird",
								type: "http",
								method: "POST",
								body: { type: "object" },
								inputSchema: { type: "object" },
								outputSchema: { type: "object" },
							},
						],
					},
				],
			}),
		).toThrow();
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
