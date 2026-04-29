import { encodeSentinel } from "@workflow-engine/core";
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
	IMAP_TRIGGER_BRAND,
	imapTrigger,
	isAction,
	isCronTrigger,
	isEnvRef,
	isHttpTrigger,
	isImapTrigger,
	isManualTrigger,
	isSecret,
	isWorkflow,
	isWsTrigger,
	MANUAL_TRIGGER_BRAND,
	ManifestSchema,
	manualTrigger,
	secret,
	WORKFLOW_BRAND,
	WS_TRIGGER_BRAND,
	wsTrigger,
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

	it("action defaults input and output to z.any() when omitted", () => {
		const a = action({ handler: async (x) => x, name: "anything" });
		expect(() => a.input.parse(42)).not.toThrow();
		expect(() => a.input.parse({ nested: { deep: true } })).not.toThrow();
		expect(() => a.input.parse(null)).not.toThrow();
		expect(() => a.output.parse("string")).not.toThrow();
		expect(() => a.output.parse(undefined)).not.toThrow();
	});

	it("httpTrigger() returns a callable branded with HTTP_TRIGGER_BRAND", () => {
		const t = httpTrigger({
			request: { body: z.object({}) },
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

	it("cronTrigger exposes schedule and tz as readonly properties", () => {
		const t = cronTrigger({
			schedule: "*/5 * * * *",
			tz: "Europe/Berlin",
			handler: async () => {},
		});
		expect(t.schedule).toBe("*/5 * * * *");
		expect(t.tz).toBe("Europe/Berlin");
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
		// @ts-expect-error "not-a-cron" is not a valid CRON literal
		cronTrigger({ schedule: "not-a-cron", handler: async () => {} });
		// 6-field cron (seconds-prefixed) is accepted by `CRON<S>`.
		cronTrigger({ schedule: "0 0 0 9 * *", handler: async () => {} });
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

	it("manualTrigger defaults inputSchema and outputSchema to z.any()", () => {
		const t = manualTrigger({ handler: async () => {} });
		// Defaults accept arbitrary shapes including non-object inputs.
		expect(() => t.inputSchema.parse({})).not.toThrow();
		expect(() => t.inputSchema.parse(42)).not.toThrow();
		expect(() => t.inputSchema.parse("hello")).not.toThrow();
		expect(() => t.outputSchema.parse(42)).not.toThrow();
		expect(() => t.outputSchema.parse(null)).not.toThrow();
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

	// ---------------------------------------------------------------------------
	// IMAP trigger
	// ---------------------------------------------------------------------------

	const imapBaseConfig = {
		host: "imap.example.com",
		port: 993,
		user: "alice",
		password: "hunter2",
		folder: "INBOX",
		search: "UNSEEN",
	};
	const imapMsg = {
		uid: 1,
		references: [] as string[],
		from: { address: "sender@example.com" },
		to: [{ address: "alice@example.com" }],
		cc: [] as { address: string }[],
		bcc: [] as { address: string }[],
		subject: "hi",
		date: "2026-01-01T00:00:00.000Z",
		headers: {} as Record<string, string[]>,
		attachments: [] as {
			contentType: string;
			size: number;
			content: string;
		}[],
	};

	it("imapTrigger() returns a callable branded with IMAP_TRIGGER_BRAND", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(typeof t).toBe("function");
		expect((t as unknown as Record<symbol, unknown>)[IMAP_TRIGGER_BRAND]).toBe(
			true,
		);
		expect(isImapTrigger(t)).toBe(true);
	});

	it("imapTrigger defaults tls to 'required'", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(t.tls).toBe("required");
	});

	it("imapTrigger defaults insecureSkipVerify to false", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(t.insecureSkipVerify).toBe(false);
	});

	it("imapTrigger defaults onError to empty envelope", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(t.onError).toEqual({});
	});

	it("imapTrigger defaults mode to 'idle'", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(t.mode).toBe("idle");
	});

	it("imapTrigger preserves explicit mode 'poll'", () => {
		const t = imapTrigger({
			...imapBaseConfig,
			mode: "poll",
			handler: async () => ({}),
		});
		expect(t.mode).toBe("poll");
	});

	it("imapTrigger mode property is readonly", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(() => {
			(t as unknown as { mode: string }).mode = "poll";
		}).toThrow();
	});

	it("imapTrigger exposes connection + dedup config as readonly properties", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(t.host).toBe("imap.example.com");
		expect(t.port).toBe(993);
		expect(t.user).toBe("alice");
		expect(t.password).toBe("hunter2");
		expect(t.folder).toBe("INBOX");
		expect(t.search).toBe("UNSEEN");
	});

	it("imapTrigger does not expose the handler as a property", () => {
		const handler = async () => ({});
		const t = imapTrigger({ ...imapBaseConfig, handler });
		expect("handler" in t).toBe(false);
	});

	it("imapTrigger callable invokes the handler with the message", async () => {
		const calls: unknown[] = [];
		const t = imapTrigger({
			...imapBaseConfig,
			handler: async (msg) => {
				calls.push(msg);
				return { command: [`UID STORE ${msg.uid} +FLAGS (\\Seen)`] };
			},
		});
		const out = await t(imapMsg);
		expect(out).toEqual({ command: ["UID STORE 1 +FLAGS (\\Seen)"] });
		expect(calls).toEqual([imapMsg]);
	});

	it("imapTrigger inputSchema validates parsed messages", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(() => t.inputSchema.parse(imapMsg)).not.toThrow();
		expect(() => t.inputSchema.parse({ uid: "not-a-number" })).toThrow();
	});

	it("imapTrigger outputSchema accepts envelope with or without command", () => {
		const t = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(() => t.outputSchema.parse({})).not.toThrow();
		expect(() =>
			t.outputSchema.parse({ command: ["UID STORE 1 +FLAGS (\\Seen)"] }),
		).not.toThrow();
		expect(() => t.outputSchema.parse({ command: [1] })).toThrow();
	});

	it("isImapTrigger distinguishes from other trigger kinds", () => {
		const http = httpTrigger({ handler: async () => ({}) });
		const cron = cronTrigger({
			schedule: "0 0 * * *",
			tz: "UTC",
			handler: async () => {},
		});
		const manual = manualTrigger({ handler: async () => {} });
		const imap = imapTrigger({ ...imapBaseConfig, handler: async () => ({}) });
		expect(isImapTrigger(http)).toBe(false);
		expect(isImapTrigger(cron)).toBe(false);
		expect(isImapTrigger(manual)).toBe(false);
		expect(isHttpTrigger(imap)).toBe(false);
		expect(isCronTrigger(imap)).toBe(false);
		expect(isManualTrigger(imap)).toBe(false);
	});

	it("isImapTrigger rejects plain values", () => {
		expect(isImapTrigger(() => 1)).toBe(false);
		expect(isImapTrigger(null)).toBe(false);
		expect(isImapTrigger({})).toBe(false);
	});

	it("imapTrigger throws when handler is omitted", () => {
		expect(() =>
			// @ts-expect-error — missing handler
			imapTrigger(imapBaseConfig),
		).toThrow(/missing a handler/);
	});

	// ---------------------------------------------------------------------------
	// WS trigger
	// ---------------------------------------------------------------------------

	it("wsTrigger() returns a callable branded with WS_TRIGGER_BRAND", () => {
		const t = wsTrigger({
			request: z.object({ greet: z.string() }),
			handler: async ({ data }) => ({ echo: data.greet }),
		});
		expect(typeof t).toBe("function");
		expect((t as unknown as Record<symbol, unknown>)[WS_TRIGGER_BRAND]).toBe(
			true,
		);
		expect(isWsTrigger(t)).toBe(true);
	});

	it("wsTrigger exposes request, response, inputSchema, outputSchema", () => {
		const req = z.object({ greet: z.string() });
		const res = z.object({ echo: z.string() });
		const t = wsTrigger({
			request: req,
			response: res,
			handler: async ({ data }) => ({ echo: data.greet }),
		});
		expect(t.request).toBe(req);
		expect(t.response).toBe(res);
		expect(t.outputSchema).toBe(res);
		// inputSchema wraps request as {data: <request>}
		const parsed = t.inputSchema.parse({ data: { greet: "hi" } });
		expect(parsed).toEqual({ data: { greet: "hi" } });
		expect(() => t.inputSchema.parse({ data: { greet: 1 } })).toThrow();
	});

	it("wsTrigger defaults response to z.any() when omitted", () => {
		const t = wsTrigger({
			request: z.object({}),
			handler: async () => "ok",
		});
		// z.any() accepts anything
		expect(t.response.parse({ anything: 1 })).toEqual({ anything: 1 });
		expect(t.response.parse(null)).toBe(null);
	});

	it("wsTrigger callable invokes the handler with the payload", async () => {
		const seen: unknown[] = [];
		const t = wsTrigger({
			request: z.object({ x: z.number() }),
			handler: async (payload) => {
				seen.push(payload);
				return { y: payload.data.x * 2 };
			},
		});
		const out = await t({ data: { x: 21 } });
		expect(out).toEqual({ y: 42 });
		expect(seen).toEqual([{ data: { x: 21 } }]);
	});

	it("wsTrigger does not expose handler as a property", () => {
		const t = wsTrigger({
			request: z.object({}),
			handler: async () => "ok",
		});
		expect("handler" in t).toBe(false);
	});

	it("isWsTrigger rejects other trigger kinds and plain values", () => {
		const ws = wsTrigger({
			request: z.object({}),
			handler: async () => "ok",
		});
		const cron = cronTrigger({
			schedule: "0 0 * * *",
			tz: "UTC",
			handler: async () => {},
		});
		const manual = manualTrigger({ handler: async () => {} });
		expect(isWsTrigger(ws)).toBe(true);
		expect(isWsTrigger(cron)).toBe(false);
		expect(isWsTrigger(manual)).toBe(false);
		expect(isWsTrigger(null)).toBe(false);
		expect(isWsTrigger({})).toBe(false);
		expect(isCronTrigger(ws)).toBe(false);
		expect(isManualTrigger(ws)).toBe(false);
		expect(isHttpTrigger(ws)).toBe(false);
		expect(isImapTrigger(ws)).toBe(false);
	});

	it("wsTrigger throws when handler is omitted", () => {
		expect(() =>
			// @ts-expect-error — missing handler
			wsTrigger({ request: z.object({}) }),
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
	it("returns an object with empty name and empty env when no config is given", () => {
		const w = defineWorkflow();
		expect(w.name).toBe("");
		expect(w.env).toEqual({});
	});

	it("captures the explicit name", () => {
		const w = defineWorkflow({ name: "cronitor" });
		expect(w.name).toBe("cronitor");
	});

	it("accepts plain string env values (build-time discovery path)", () => {
		const w = defineWorkflow({
			name: "x",
			env: { A: "hello" },
			envSource: {},
		});
		expect(w.env.A).toBe("hello");
	});

	it("freezes the outer workflow object (env is mutable for in-place population)", () => {
		const w = defineWorkflow({ name: "x", env: { A: "hello" }, envSource: {} });
		expect(Object.isFrozen(w)).toBe(true);
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

	it("defaults request.body to z.any when the author doesn't declare it", () => {
		// The SDK fills request.body with z.any() when omitted, and request.headers
		// with an empty Zod object schema. Envelope composition happens at build
		// time in the plugin (tested in workflow-build.test.ts).
		const t = httpTrigger({
			handler: async () => ({}),
		});
		expect(t.request.body).toBeDefined();
		expect(() => t.request.body.parse({ anything: 1 })).not.toThrow();
		expect(() => t.request.body.parse(null)).not.toThrow();
	});

	it("defaults request.headers to an empty Zod object", () => {
		const t = httpTrigger({
			handler: async () => ({}),
		});
		expect(t.request.headers).toBeDefined();
		// Empty Zod object — undeclared keys are stripped by Zod's default
		// `.object()` behaviour.
		const parsed = t.request.headers.parse({ "x-extra": "v" }) as Record<
			string,
			unknown
		>;
		expect(parsed).toEqual({});
	});

	it("stores the provided request.body schema verbatim", () => {
		const body = z.object({ orderId: z.string() });
		const t = httpTrigger({
			request: { body },
			handler: async () => ({}),
		});
		expect(t.request.body).toBe(body);
	});

	it("auto-wraps request.headers with .meta({ strip: true }) by default", () => {
		// The SDK's httpTrigger factory wraps the author's request.headers
		// schema with .meta({ strip: true }) when the author hasn't expressed
		// an explicit mode preference, so the manifest carries the strip-
		// silently marker, which the runtime rehydrator restores into .strip()
		// mode. The auto-wrap is overridable — see the .meta({ strip: false })
		// and .loose() override tests below.
		const headers = z.object({ "x-trace-id": z.string() });
		const t = httpTrigger({
			request: { headers },
			handler: async () => ({}),
		});
		const json = z.toJSONSchema(t.request.headers) as Record<string, unknown>;
		expect(json.strip).toBe(true);
		expect(json.additionalProperties).toBe(false);
		expect(
			(json.properties as Record<string, unknown>)["x-trace-id"],
		).toBeDefined();
	});

	it("respects author's explicit .meta({ strip: false }) on request.headers", () => {
		const headers = z
			.object({ "x-trace-id": z.string() })
			.meta({ strip: false });
		const t = httpTrigger({
			request: { headers },
			handler: async () => ({}),
		});
		const json = z.toJSONSchema(t.request.headers) as Record<string, unknown>;
		expect(json.strip).toBe(false); // author's value, not auto-wrapped
	});

	it("respects author's .loose() on request.headers (no auto-wrap)", () => {
		const headers = z.object({ "x-trace-id": z.string() }).loose();
		const t = httpTrigger({
			request: { headers },
			handler: async () => ({}),
		});
		const json = z.toJSONSchema(t.request.headers) as Record<string, unknown>;
		// .loose() emits additionalProperties: {} (any). No `strip` marker
		// added — author chose passthrough explicitly.
		expect(json.additionalProperties).toEqual({});
		expect("strip" in json).toBe(false);
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

	it("stores response.body verbatim for plugin-side envelope composition", () => {
		const body = z.object({ orderId: z.string() });
		const t = httpTrigger({
			response: { body },
			handler: async () => ({ body: { orderId: "x" } }),
		});
		expect(t.response.body).toBe(body);
	});

	it("stores response.headers verbatim", () => {
		const headers = z.object({ "x-app-version": z.string() });
		const t = httpTrigger({
			response: { headers },
			handler: async () => ({ headers: { "x-app-version": "1.0" } }),
		});
		expect(t.response.headers).toBe(headers);
	});

	it("leaves response.body and response.headers undefined when omitted", () => {
		const t = httpTrigger({ handler: async () => ({}) });
		expect(t.response.body).toBeUndefined();
		expect(t.response.headers).toBeUndefined();
	});

	it("TypeScript narrows the handler return type when response.body is declared", () => {
		// Compile-time assertion only: when `response.body` is declared, the
		// handler return type requires `body`. A handler returning `{status: 202}`
		// without `body` fails TS at compile time. We assert the positive case
		// compiles; the negative case is enforced by TypeScript.
		const t = httpTrigger({
			response: { body: z.object({ orderId: z.string() }) },
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
				request: {
					body: { type: "object" },
					headers: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
				},
				inputSchema: { type: "object" },
				outputSchema: { type: "object" },
			},
		],
	};

	const validManifest = { workflows: [validWorkflow] };

	it("accepts a valid v1 owner manifest", () => {
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
							request: {
								body: { type: "object" },
								headers: {
									type: "object",
									properties: {},
									additionalProperties: false,
								},
							},
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
								request: {
									body: { type: "object" },
									headers: {
										type: "object",
										properties: {},
										additionalProperties: false,
									},
								},
								inputSchema: { type: "object" },
								outputSchema: { type: "object" },
							},
						],
					},
				],
			}),
		).toThrow();
	});

	it("rejects a owner manifest missing the workflows array", () => {
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

	it("rejects duplicate workflow names within one owner manifest", () => {
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

// ---------------------------------------------------------------------------
// env({ secret: true }) + secret() factory (workflow-secrets)
// ---------------------------------------------------------------------------

describe("env({ secret: true })", () => {
	it("returns an EnvRef flagged as secret", () => {
		const ref = env({ secret: true });
		expect(isEnvRef(ref)).toBe(true);
		expect(isSecret(ref)).toBe(true);
	});

	it("captures the explicit name", () => {
		const ref = env({ name: "TOKEN", secret: true });
		expect(isEnvRef(ref)).toBe(true);
		expect(isSecret(ref)).toBe(true);
		expect(ref.name).toBe("TOKEN");
	});

	it("plain env() returns an EnvRef not flagged as secret", () => {
		const ref = env({ default: "x" });
		expect(isEnvRef(ref)).toBe(true);
		expect(isSecret(ref)).toBe(false);
	});

	it("resolveEnvRecord (via defineWorkflow build-time path) emits sentinels for secret bindings", () => {
		const w = defineWorkflow({
			name: "wf",
			env: {
				REGION: env({ default: "us-east-1" }),
				TOKEN: env({ name: "TOKEN", secret: true }),
			},
			envSource: { TOKEN: "leaked-would-be-bad" },
		});
		// Plaintext entries keep their resolved value at build time.
		expect(w.env.REGION).toBe("us-east-1");
		// Secret entries resolve to a sentinel string — NOT to the CLI-env
		// plaintext. The sentinel references the effective manifest name.
		expect(w.env.TOKEN).toBe(encodeSentinel("TOKEN"));
		expect(w.env.TOKEN).not.toContain("leaked-would-be-bad");
	});

	it("resolveEnvRecord uses the property key as the sentinel name when no override given", () => {
		const w = defineWorkflow({
			name: "wf",
			env: {
				PROP_KEY: env({ secret: true }),
			},
			envSource: { PROP_KEY: "value" },
		});
		expect(w.env.PROP_KEY).toBe(encodeSentinel("PROP_KEY"));
	});

	it("resolveEnvRecord honours ref.name override for the sentinel", () => {
		const w = defineWorkflow({
			name: "wf",
			env: {
				LOCAL: env({ secret: true, name: "MANIFEST_NAME" }),
			},
			envSource: { MANIFEST_NAME: "value" },
		});
		// The sentinel carries the manifest-visible name, not the property key.
		expect(w.env.LOCAL).toBe(encodeSentinel("MANIFEST_NAME"));
	});

	it("throws when a secret env var is missing (parity with plain env())", () => {
		expect(() => {
			defineWorkflow({
				name: "wf",
				env: { TOKEN: env({ secret: true }) },
				envSource: {},
			});
		}).toThrow("Missing environment variable: TOKEN");
	});

	it("uses the explicit name in the missing-secret error", () => {
		expect(() => {
			defineWorkflow({
				name: "wf",
				env: { tok: env({ secret: true, name: "API_TOKEN" }) },
				envSource: {},
			});
		}).toThrow("Missing environment variable: API_TOKEN");
	});

	it("sentinel composes cleanly inside template literals", () => {
		const w = defineWorkflow({
			name: "wf",
			env: { T: env({ secret: true }) },
			envSource: { T: "value" },
		});
		const composed = `Bearer ${w.env.T}`;
		expect(composed).toBe(`Bearer ${encodeSentinel("T")}`);
	});

	it("runtime branch reads from globalThis.workflow.env (plaintext) and ignores sentinel emission", () => {
		const g = globalThis as Record<string, unknown>;
		const prev = g.workflow;
		g.workflow = Object.freeze({
			name: "wf",
			env: Object.freeze({ TOKEN: "real_plaintext" }),
		});
		try {
			const w = defineWorkflow({
				name: "wf",
				env: { TOKEN: env({ secret: true }) },
			});
			expect(w.env.TOKEN).toBe("real_plaintext");
			expect(w.env.TOKEN).not.toContain("\x00secret:");
		} finally {
			g.workflow = prev;
		}
	});
});

describe("secret()", () => {
	afterEach(() => {
		(globalThis as Record<string, unknown>).$secrets = undefined;
	});

	it("returns the input unchanged when $secrets is absent", () => {
		const out = secret("hello");
		expect(out).toBe("hello");
	});

	it("calls $secrets.addSecret when installed", () => {
		const addSecret = vi.fn();
		(globalThis as Record<string, unknown>).$secrets = { addSecret };
		const out = secret("ghp_xxx");
		expect(out).toBe("ghp_xxx");
		expect(addSecret).toHaveBeenCalledWith("ghp_xxx");
	});

	it("multiple calls each invoke addSecret", () => {
		const addSecret = vi.fn();
		(globalThis as Record<string, unknown>).$secrets = { addSecret };
		secret("a");
		secret("b");
		expect(addSecret).toHaveBeenCalledTimes(2);
	});
});
