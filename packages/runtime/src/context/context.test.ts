import { describe, expect, it, vi } from "vitest";
import {
	type BusConsumer,
	createEventBus,
	type EventBus,
	type RuntimeEvent,
} from "../event-bus/index.js";
import { createEventSource, type EventSource } from "../event-source.js";
import { PayloadValidationError } from "./errors.js";
import { ActionContext, createActionContext } from "./index.js";

const EVT_PREFIX = /^evt_/;
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
	env?: Record<string, string>;
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
	const factory = createActionContext(source);
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

		it("ctx does not have a fetch property", () => {
			const { createContext } = createTestSetup();
			const ctx = createContext(makeEvent(), "test-action");

			expect("fetch" in ctx).toBe(false);
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
			const factory = createActionContext(source);
			const ctx = factory(makeEvent(), "test-action", {});

			await expect(ctx.emit("order.received", {})).rejects.toThrow();
			expect(emitSpy).not.toHaveBeenCalled();
		});
	});
});
