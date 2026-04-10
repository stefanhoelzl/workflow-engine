import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	type BusConsumer,
	type EventBus,
	type RuntimeEvent,
	createEventBus,
} from "../event-bus/index.js";
import { createEventSource, type EventSource } from "../event-source.js";
import { type Logger, createLogger } from "../logger.js";
import { ActionContext, createActionContext } from "./index.js";
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
		logger: createLogger("context", {
			level: level as "info",
			destination: stream,
		}),
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
const mockFetch = vi.fn() as unknown as typeof globalThis.fetch;
const mockEnv: Record<string, string> = { API_KEY: "secret" };

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
		async bootstrap() {
			/* no-op */
		},
	};
	return { bus: createEventBus([collector]), emitted };
}

function createTestSetup(overrides?: {
	bus?: EventBus;
	schemas?: Record<string, { parse(data: unknown): unknown }>;
	fetch?: typeof globalThis.fetch;
	env?: Record<string, string>;
	logger?: Logger;
}): {
	createContext: (
		event: RuntimeEvent,
		actionName: string,
		env?: Record<string, string>,
	) => ActionContext;
	source: EventSource;
	bus: EventBus;
	emitted: RuntimeEvent[];
} {
	const { bus: defaultBus, emitted } = createCollectorBus();
	const bus = overrides?.bus ?? defaultBus;
	const schemas = overrides?.schemas ?? defaultSchemas;
	const source = createEventSource({ events: schemas }, bus);
	const defaultEnv = overrides?.env ?? mockEnv;
	const factory = createActionContext(
		source,
		overrides?.fetch ?? mockFetch,
		overrides?.logger ?? silentLogger,
	);
	const createContext = (
		event: RuntimeEvent,
		actionName: string,
		env?: Record<string, string>,
	) => factory(event, actionName, env ?? defaultEnv);
	return { createContext, source, bus, emitted };
}

function makeEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: "evt_001",
		type: "order.received",
		payload: { orderId: "123" },
		correlationId: "corr_abc",
		createdAt: new Date(),
		emittedAt: new Date(),
		state: "pending",
		sourceType: "trigger",
		sourceName: "orders",
		...overrides,
	} as RuntimeEvent;
}

describe("createActionContext", () => {
	describe("action", () => {
		it("returns an ActionContext with the source event", () => {
			const { createContext } = createTestSetup();
			const event = makeEvent();

			const ctx = createContext(event, "test-action");

			expect(ctx).toBeInstanceOf(ActionContext);
			expect(ctx.event).toBe(event);
		});

		it("emit creates child RuntimeEvent inheriting correlationId and setting parentEventId", async () => {
			const { createContext, emitted } = createTestSetup();
			const parentEvent = makeEvent({
				id: "evt_parent",
				correlationId: "corr_xyz",
			});

			const ctx = createContext(parentEvent, "test-action");
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
			expect(child.sourceType).toBe("action");
			expect(child.sourceName).toBe("test-action");
		});

		it("multiple emits all inherit from the same parent", async () => {
			const { createContext, emitted } = createTestSetup();
			const parentEvent = makeEvent({
				id: "evt_parent",
				correlationId: "corr_xyz",
			});

			const ctx = createContext(parentEvent, "test-action");
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
			const { createContext } = createTestSetup({
				fetch: fetchSpy as typeof globalThis.fetch,
			});
			const ctx = createContext(makeEvent(), "test-action");

			const res = await ctx.fetch("https://api.example.com/orders/123");

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.example.com/orders/123",
				undefined,
			);
			expect(await res.text()).toBe("ok");
		});

		it("delegates POST request with options to injected fetch", async () => {
			const fetchSpy = vi.fn().mockResolvedValue(Response.json({ id: "123" }));
			const { createContext } = createTestSetup({
				fetch: fetchSpy as typeof globalThis.fetch,
			});
			const ctx = createContext(makeEvent(), "test-action");

			const init = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "123" }),
			};
			const res = await ctx.fetch("https://api.example.com/orders", init);

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.example.com/orders",
				init,
			);
			expect(res).toBeInstanceOf(Response);
		});

		it("propagates fetch errors to the caller", async () => {
			const fetchSpy = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
			const { createContext } = createTestSetup({
				fetch: fetchSpy as typeof globalThis.fetch,
			});
			const ctx = createContext(makeEvent(), "test-action");

			await expect(
				ctx.fetch("https://unreachable.example.com"),
			).rejects.toThrow("fetch failed");
		});
	});

	describe("action env", () => {
		it("exposes injected env record on ctx.env", () => {
			const { createContext } = createTestSetup({
				env: { FOO: "bar", BAZ: "qux" },
			});
			const ctx = createContext(makeEvent(), "test-action");

			expect(ctx.env).toEqual({ FOO: "bar", BAZ: "qux" });
		});

		it("env only contains declared keys", () => {
			const { createContext } = createTestSetup({ env: { FOO: "bar" } });
			const ctx = createContext(makeEvent(), "test-action");

			expect(Object.keys(ctx.env)).toEqual(["FOO"]);
		});
	});

	describe("fetch logging", () => {
		it("logs fetch.start and fetch.completed on success", async () => {
			const { logger, lines } = createTestLogger();
			const fetchSpy = vi
				.fn()
				.mockResolvedValue(new Response("ok", { status: 200 }));
			const { createContext } = createTestSetup({
				fetch: fetchSpy as typeof globalThis.fetch,
				logger,
			});
			const ctx = createContext(
				makeEvent({ correlationId: "corr_fetch" }),
				"test-action",
			);

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
			const { createContext } = createTestSetup({
				fetch: fetchSpy as typeof globalThis.fetch,
				logger,
			});
			const ctx = createContext(makeEvent(), "test-action");

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
			const fetchSpy = vi
				.fn()
				.mockRejectedValue(new TypeError("network error"));
			const { createContext } = createTestSetup({
				fetch: fetchSpy as typeof globalThis.fetch,
				logger,
			});
			const ctx = createContext(makeEvent(), "test-action");

			await expect(
				ctx.fetch("https://unreachable.example.com"),
			).rejects.toThrow("network error");

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
			const { createContext, emitted } = createTestSetup({
				schemas: { "order.received": schema },
			});
			const ctx = createContext(makeEvent(), "test-action");
			await ctx.emit("order.received", { orderId: "abc", extra: true });

			expect(emitted[0]?.payload).toEqual({ orderId: "abc" });
		});

		it("throws PayloadValidationError for invalid payload", async () => {
			const schema = {
				parse: () => {
					const error = new Error("validation failed");
					Object.assign(error, {
						issues: [
							{
								path: ["orderId"],
								message: "Expected string, received number",
							},
						],
					});
					throw error;
				},
			};
			const { createContext } = createTestSetup({
				schemas: { "order.received": schema },
			});
			const ctx = createContext(makeEvent(), "test-action");

			const error = await ctx
				.emit("order.received", { orderId: 123 })
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(PayloadValidationError);
			const pve = error as PayloadValidationError;
			expect(pve.eventType).toBe("order.received");
			expect(pve.issues).toEqual([
				{ path: "orderId", message: "Expected string, received number" },
			]);
		});

		it("throws PayloadValidationError for unknown event type", async () => {
			const { createContext } = createTestSetup({ schemas: {} });
			const ctx = createContext(makeEvent(), "test-action");

			const error = await ctx
				.emit("order.unknown", {})
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(PayloadValidationError);
			const pve = error as PayloadValidationError;
			expect(pve.eventType).toBe("order.unknown");
			expect(pve.issues).toEqual([]);
		});

		it("does not emit to bus when validation fails", async () => {
			const schema = {
				parse: () => {
					throw new Error("invalid");
				},
			};
			const emitSpy = vi.fn();
			const fakeBus = {
				emit: emitSpy,
				bootstrap: vi.fn(),
			} as unknown as EventBus;
			const source = createEventSource(
				{ events: { "order.received": schema } },
				fakeBus,
			);
			const factory = createActionContext(source, mockFetch, silentLogger);
			const ctx = factory(makeEvent(), "test-action", {});

			await expect(ctx.emit("order.received", {})).rejects.toThrow();
			expect(emitSpy).not.toHaveBeenCalled();
		});
	});
});
