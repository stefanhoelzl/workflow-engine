import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { type BusConsumer, type EventBus, type RuntimeEvent, createEventBus } from "../event-bus/index.js";
import { createEventFactory, type EventFactory } from "../event-factory.js";
import { type Logger, createLogger } from "../logger.js";
import { ActionContext, ContextFactory, HttpTriggerContext } from "./index.js";
import { PayloadValidationError } from "./errors.js";

const silentLogger = createLogger("test", { level: "silent" });

function createTestLogger(level = "info"): {
	logger: Logger;
	lines: () => Record<string, unknown>[];
} {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk);
			callback();
		},
	});
	return {
		logger: createLogger("context", { level: level as "info", destination: stream }),
		lines: () =>
			chunks
				.map((c) => c.toString())
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

const EVT_PREFIX = /^evt_/;
const CORR_PREFIX = /^corr_/;
const mockFetch = vi.fn() as unknown as typeof globalThis.fetch;
// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
const mockEnv: Record<string, string | undefined> = { API_KEY: "secret", EMPTY: undefined };

const passthroughSchema = { parse: (d: unknown) => d };
const defaultSchemas: Record<string, { parse(data: unknown): unknown }> = {
	"order.received": passthroughSchema,
	"order.validated": passthroughSchema,
	"order.logged": passthroughSchema,
	"test.event": passthroughSchema,
};

function createCollectorBus(): { bus: EventBus; emitted: RuntimeEvent[] } {
	const emitted: RuntimeEvent[] = [];
	const collector: BusConsumer = {
		async handle(event) {
			emitted.push(event);
		},
		async bootstrap() { /* no-op */ },
	};
	return { bus: createEventBus([collector]), emitted };
}

function createTestFactory(overrides?: {
	bus?: EventBus;
	schemas?: Record<string, { parse(data: unknown): unknown }>;
	eventFactory?: EventFactory;
	fetch?: typeof globalThis.fetch;
	env?: Record<string, string | undefined>;
	logger?: Logger;
}): { factory: ContextFactory; bus: EventBus; emitted: RuntimeEvent[] } {
	const { bus: defaultBus, emitted } = createCollectorBus();
	const bus = overrides?.bus ?? defaultBus;
	const eventFactory = overrides?.eventFactory ?? createEventFactory(overrides?.schemas ?? defaultSchemas);
	const factory = new ContextFactory(
		bus,
		eventFactory,
		overrides?.fetch ?? mockFetch,
		overrides?.env ?? mockEnv,
		overrides?.logger ?? silentLogger,
	);
	return { factory, bus, emitted };
}

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		id: "evt_001",
		type: "order.received",
		payload: { orderId: "123" },
		correlationId: "corr_abc",
		createdAt: new Date(),
		state: "pending",
		...overrides,
	};
}

describe("ContextFactory", () => {
	describe("httpTrigger", () => {
		it("returns an HttpTriggerContext with request and definition", () => {
			const { factory } = createTestFactory();
			const definition = {
				path: "order",
				method: "POST",
				event: "order.received",
				response: { status: 202 as const, body: { accepted: true } },
			};

			const ctx = factory.httpTrigger({ orderId: "abc" }, definition);

			expect(ctx).toBeInstanceOf(HttpTriggerContext);
			expect(ctx.request.body).toEqual({ orderId: "abc" });
			expect(ctx.definition).toBe(definition);
		});

		it("emit creates RuntimeEvent with pending state and emits to bus", async () => {
			const { factory, emitted } = createTestFactory();
			const definition = {
				path: "order",
				method: "POST",
				event: "order.received",
				response: { status: 202 as const, body: { accepted: true } },
			};

			const ctx = factory.httpTrigger({ orderId: "abc" }, definition);
			await ctx.emit("order.received", { orderId: "abc" });

			expect(emitted.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const event = emitted[0]!;
			expect(event.type).toBe("order.received");
			expect(event.payload).toEqual({ orderId: "abc" });
			expect(event.id).toMatch(EVT_PREFIX);
			expect(event.correlationId).toMatch(CORR_PREFIX);
			expect(event.parentEventId).toBeUndefined();
			expect(event.targetAction).toBeUndefined();
			expect(event.createdAt).toBeInstanceOf(Date);
			expect(event.state).toBe("pending");
		});
	});

	describe("action", () => {
		it("returns an ActionContext with the source event", () => {
			const { factory } = createTestFactory();
			const event = makeEvent();

			const ctx = factory.action(event);

			expect(ctx).toBeInstanceOf(ActionContext);
			expect(ctx.event).toBe(event);
		});

		it("emit creates child RuntimeEvent inheriting correlationId and setting parentEventId", async () => {
			const { factory, emitted } = createTestFactory();
			const parentEvent = makeEvent({
				id: "evt_parent",
				correlationId: "corr_xyz",
			});

			const ctx = factory.action(parentEvent);
			await ctx.emit("order.validated", { valid: true });

			expect(emitted.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const child = emitted[0]!;
			expect(child.type).toBe("order.validated");
			expect(child.payload).toEqual({ valid: true });
			expect(child.correlationId).toBe("corr_xyz");
			expect(child.parentEventId).toBe("evt_parent");
			expect(child.id).toMatch(EVT_PREFIX);
			expect(child.targetAction).toBeUndefined();
			expect(child.state).toBe("pending");
		});

		it("multiple emits all inherit from the same parent", async () => {
			const { factory, emitted } = createTestFactory();
			const parentEvent = makeEvent({
				id: "evt_parent",
				correlationId: "corr_xyz",
			});

			const ctx = factory.action(parentEvent);
			await ctx.emit("order.validated", { valid: true });
			await ctx.emit("order.logged", { logged: true });

			expect(emitted.length).toBe(2);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const first = emitted[0]!;
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const second = emitted[1]!;

			expect(first.correlationId).toBe("corr_xyz");
			expect(first.parentEventId).toBe("evt_parent");
			expect(second.correlationId).toBe("corr_xyz");
			expect(second.parentEventId).toBe("evt_parent");
			expect(first.id).not.toBe(second.id);
		});
	});

	describe("action fetch", () => {
		it("delegates GET request to injected fetch", async () => {
			const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
			const { factory } = createTestFactory({ fetch: fetchSpy as typeof globalThis.fetch });
			const ctx = factory.action(makeEvent());

			const res = await ctx.fetch("https://api.example.com/orders/123");

			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/orders/123", undefined);
			expect(await res.text()).toBe("ok");
		});

		it("delegates POST request with options to injected fetch", async () => {
			const fetchSpy = vi.fn().mockResolvedValue(Response.json({ id: "123" }));
			const { factory } = createTestFactory({ fetch: fetchSpy as typeof globalThis.fetch });
			const ctx = factory.action(makeEvent());

			const init = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "123" }),
			};
			const res = await ctx.fetch("https://api.example.com/orders", init);

			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/orders", init);
			expect(res).toBeInstanceOf(Response);
		});

		it("propagates fetch errors to the caller", async () => {
			const fetchSpy = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
			const { factory } = createTestFactory({ fetch: fetchSpy as typeof globalThis.fetch });
			const ctx = factory.action(makeEvent());

			await expect(ctx.fetch("https://unreachable.example.com")).rejects.toThrow("fetch failed");
		});
	});

	describe("action env", () => {
		it("exposes injected env record on ctx.env", () => {
			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			const { factory } = createTestFactory({ env: { FOO: "bar", BAZ: "qux" } });
			const ctx = factory.action(makeEvent());

			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			expect(ctx.env).toEqual({ FOO: "bar", BAZ: "qux" });
		});

		it("returns undefined for missing env keys", () => {
			// biome-ignore lint/style/useNamingConvention: env var names are SCREAMING_CASE by convention
			const { factory } = createTestFactory({ env: { FOO: "bar" } });
			const ctx = factory.action(makeEvent());

			expect(ctx.env.MISSING).toBeUndefined();
		});
	});

	describe("arrow property binding", () => {
		it("factory.httpTrigger works when passed as a standalone reference", async () => {
			const { factory, emitted } = createTestFactory();
			const definition = {
				path: "order",
				method: "POST",
				event: "order.received",
				response: { status: 202 as const, body: { accepted: true } },
			};

			const createCtx = factory.httpTrigger;
			const ctx = createCtx({ orderId: "abc" }, definition);

			await ctx.emit("order.received", { orderId: "abc" });
			expect(emitted[0]?.correlationId).toMatch(CORR_PREFIX);
		});

		it("factory.action works when passed as a standalone reference", async () => {
			const { factory, emitted } = createTestFactory();
			const event = makeEvent();

			const createCtx = factory.action;
			const ctx = createCtx(event);

			await ctx.emit("test.event", {});
			expect(emitted[0]?.correlationId).toBe("corr_abc");
		});
	});

	describe("emit logging", () => {
		it("logs event.emitted at info level for root events from trigger", async () => {
			const { logger, lines } = createTestLogger();
			const { factory } = createTestFactory({ logger });
			const definition = {
				path: "order",
				method: "POST",
				event: "order.received",
				response: { status: 202 as const, body: { accepted: true } },
			};

			const ctx = factory.httpTrigger({ orderId: "abc" }, definition);
			await ctx.emit("order.received", { orderId: "abc" });

			const output = lines();
			const emitted = output.find((l) => l.msg === "event.emitted");
			expect(emitted).toBeDefined();
			expect(emitted?.type).toBe("order.received");
			expect(emitted?.correlationId).toMatch(CORR_PREFIX);
			expect(emitted?.eventId).toMatch(EVT_PREFIX);
			expect(emitted?.parentEventId).toBeUndefined();
		});

		it("logs event.emitted at info level for child events from action", async () => {
			const { logger, lines } = createTestLogger();
			const { factory } = createTestFactory({ logger });
			const parentEvent = makeEvent({ id: "evt_parent", correlationId: "corr_xyz" });

			const ctx = factory.action(parentEvent);
			await ctx.emit("order.validated", { valid: true });

			const output = lines();
			const emitted = output.find((l) => l.msg === "event.emitted");
			expect(emitted).toBeDefined();
			expect(emitted?.correlationId).toBe("corr_xyz");
			expect(emitted?.parentEventId).toBe("evt_parent");
			expect(emitted?.type).toBe("order.validated");
		});

		it("logs event.emitted.payload at trace level", async () => {
			const { logger, lines } = createTestLogger("trace");
			const { factory } = createTestFactory({ logger });
			const ctx = factory.action(makeEvent());
			await ctx.emit("order.validated", { orderId: "123" });

			const output = lines();
			const payload = output.find((l) => l.msg === "event.emitted.payload");
			expect(payload).toBeDefined();
			expect(payload?.payload).toEqual({ orderId: "123" });
		});

		it("includes targetAction in log when set", async () => {
			const { logger, lines } = createTestLogger();
			const { factory } = createTestFactory({ logger });
			const ctx = factory.action(makeEvent());
			await ctx.emit("order.received", {}, { targetAction: "notify" });

			const output = lines();
			const emitted = output.find((l) => l.msg === "event.emitted");
			expect(emitted?.targetAction).toBe("notify");
		});
	});

	describe("fetch logging", () => {
		it("logs fetch.start and fetch.completed on success", async () => {
			const { logger, lines } = createTestLogger();
			const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
			const { factory } = createTestFactory({ fetch: fetchSpy as typeof globalThis.fetch, logger });
			const ctx = factory.action(makeEvent({ correlationId: "corr_fetch" }));

			await ctx.fetch("https://api.example.com/orders/123");

			const output = lines();
			const start = output.find((l) => l.msg === "fetch.start");
			const completed = output.find((l) => l.msg === "fetch.completed");

			expect(start).toBeDefined();
			expect(start?.url).toBe("https://api.example.com/orders/123");
			expect(start?.method).toBe("GET");
			expect(start?.correlationId).toBe("corr_fetch");

			expect(completed).toBeDefined();
			expect(completed?.status).toBe(200);
			expect(completed?.durationMs).toBeTypeOf("number");
		});

		it("logs fetch.request.body at trace level", async () => {
			const { logger, lines } = createTestLogger("trace");
			const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
			const { factory } = createTestFactory({ fetch: fetchSpy as typeof globalThis.fetch, logger });
			const ctx = factory.action(makeEvent());

			await ctx.fetch("https://api.example.com/orders", {
				method: "POST",
				body: JSON.stringify({ id: "123" }),
			});

			const output = lines();
			const body = output.find((l) => l.msg === "fetch.request.body");
			expect(body).toBeDefined();
			expect(body?.body).toBe(JSON.stringify({ id: "123" }));
		});

		it("logs fetch.failed on error", async () => {
			const { logger, lines } = createTestLogger();
			const fetchSpy = vi.fn().mockRejectedValue(new TypeError("network error"));
			const { factory } = createTestFactory({ fetch: fetchSpy as typeof globalThis.fetch, logger });
			const ctx = factory.action(makeEvent());

			await expect(ctx.fetch("https://unreachable.example.com")).rejects.toThrow("network error");

			const output = lines();
			const failed = output.find((l) => l.msg === "fetch.failed");
			expect(failed).toBeDefined();
			expect(failed?.error).toBe("network error");
			expect(failed?.durationMs).toBeTypeOf("number");
			expect(failed?.level).toBe(50);
		});
	});

	describe("payload validation", () => {
		it("emits event with parsed output from schema", async () => {
			const schema = {
				parse: (d: unknown) => {
					const data = d as Record<string, unknown>;
					return { orderId: String(data.orderId) };
				},
			};
			const { factory, emitted } = createTestFactory({
				schemas: { "order.received": schema },
			});
			const ctx = factory.action(makeEvent());
			await ctx.emit("order.received", { orderId: "abc", extra: true });

			expect(emitted[0]?.payload).toEqual({ orderId: "abc" });
		});

		it("throws PayloadValidationError for invalid payload", async () => {
			const schema = {
				parse: () => {
					const error = new Error("validation failed");
					Object.assign(error, {
						issues: [{ path: ["orderId"], message: "Expected string, received number" }],
					});
					throw error;
				},
			};
			const { factory } = createTestFactory({
				schemas: { "order.received": schema },
			});
			const ctx = factory.action(makeEvent());

			const error = await ctx.emit("order.received", { orderId: 123 }).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(PayloadValidationError);
			const pve = error as PayloadValidationError;
			expect(pve.eventType).toBe("order.received");
			expect(pve.issues).toEqual([{ path: "orderId", message: "Expected string, received number" }]);
		});

		it("throws PayloadValidationError for unknown event type", async () => {
			const { factory } = createTestFactory({ schemas: {} });
			const ctx = factory.action(makeEvent());

			const error = await ctx.emit("order.unknown", {}).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(PayloadValidationError);
			const pve = error as PayloadValidationError;
			expect(pve.eventType).toBe("order.unknown");
			expect(pve.issues).toEqual([]);
		});

		it("does not emit to bus when validation fails", async () => {
			const schema = {
				parse: () => { throw new Error("invalid"); },
			};
			const emitSpy = vi.fn();
			const fakeBus = {
				emit: emitSpy,
				bootstrap: vi.fn(),
			} as unknown as EventBus;
			const { factory } = createTestFactory({
				bus: fakeBus,
				schemas: { "order.received": schema },
			});
			const ctx = factory.action(makeEvent());

			await expect(ctx.emit("order.received", {})).rejects.toThrow();
			expect(emitSpy).not.toHaveBeenCalled();
		});
	});
});
