import { describe, expect, it } from "vitest";
import { PayloadValidationError } from "./context/errors.js";
import type { BusConsumer, RuntimeEvent } from "./event-bus/index.js";
import { createEventBus } from "./event-bus/index.js";
import { createEventSource } from "./event-source.js";

const EVT_PREFIX = /^evt_/;

const passthroughSchema = { parse: (d: unknown) => d };

function createCollector() {
	const events: RuntimeEvent[] = [];
	const consumer: BusConsumer = {
		async handle(event) { events.push(event); },
		async bootstrap() { /* no-op */ },
	};
	return { events, consumer };
}

function makeSource(schemas: Record<string, { parse(data: unknown): unknown }> = {}) {
	const collector = createCollector();
	const bus = createEventBus([collector.consumer]);
	const source = createEventSource(schemas, bus);
	return { source, emitted: collector.events };
}

function makeParent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: "evt_parent",
		type: "order.received",
		payload: { orderId: "abc" },
		correlationId: "corr_xyz",
		createdAt: new Date(),
		emittedAt: new Date(),
		state: "pending",
		sourceType: "trigger",
		sourceName: "orders",
		...overrides,
	} as RuntimeEvent;
}

describe("createEventSource", () => {
	describe("create", () => {
		it("returns a pending RuntimeEvent and emits it", async () => {
			const { source, emitted } = makeSource({ "order.received": passthroughSchema });

			const event = await source.create("order.received", { orderId: "abc" }, "orders");

			expect(event.id).toMatch(EVT_PREFIX);
			expect(event.type).toBe("order.received");
			expect(event.payload).toEqual({ orderId: "abc" });
			expect(event.correlationId).toBeDefined();
			expect(event.createdAt).toBeInstanceOf(Date);
			expect(event.emittedAt).toBeInstanceOf(Date);
			expect(event.state).toBe("pending");
			expect(event.parentEventId).toBeUndefined();
			expect(event.targetAction).toBeUndefined();
			expect(emitted).toHaveLength(1);
			expect(emitted[0]).toBe(event);
		});

		it("uses parsed output from schema", async () => {
			const schema = {
				parse: (d: unknown) => ({ orderId: String((d as Record<string, unknown>).orderId) }),
			};
			const { source } = makeSource({ "order.received": schema });

			const event = await source.create("order.received", { orderId: "abc", extra: true }, "orders");

			expect(event.payload).toEqual({ orderId: "abc" });
		});

		it("throws PayloadValidationError for invalid payload and does not emit", async () => {
			const schema = {
				parse: () => {
					const error = new Error("validation failed");
					Object.assign(error, {
						issues: [{ path: ["orderId"], message: "Expected string" }],
					});
					throw error;
				},
			};
			const { source, emitted } = makeSource({ "order.received": schema });

			await expect(source.create("order.received", { orderId: 123 }, "orders")).rejects.toThrow(
				PayloadValidationError,
			);
			expect(emitted).toHaveLength(0);
		});

		it("throws PayloadValidationError for unknown event type", async () => {
			const { source } = makeSource({});

			try {
				await source.create("order.unknown", {}, "orders");
				expect.unreachable("should throw");
			} catch (e) {
				expect(e).toBeInstanceOf(PayloadValidationError);
				expect((e as PayloadValidationError).eventType).toBe("order.unknown");
				expect((e as PayloadValidationError).issues).toEqual([]);
			}
		});
	});

	describe("derive", () => {
		it("returns a child event and emits it", async () => {
			const { source, emitted } = makeSource({ "order.validated": passthroughSchema });
			const parent = makeParent();

			const event = await source.derive(parent, "order.validated", { valid: true }, "validateOrder");

			expect(event.id).toMatch(EVT_PREFIX);
			expect(event.id).not.toBe(parent.id);
			expect(event.type).toBe("order.validated");
			expect(event.payload).toEqual({ valid: true });
			expect(event.correlationId).toBe("corr_xyz");
			expect(event.parentEventId).toBe("evt_parent");
			expect(event.state).toBe("pending");
			expect(event.targetAction).toBeUndefined();
			expect(event.emittedAt).toBeInstanceOf(Date);
			expect(emitted).toHaveLength(1);
			expect(emitted[0]).toBe(event);
		});

		it("throws PayloadValidationError and does not emit", async () => {
			const schema = {
				parse: () => {
					const error = new Error("validation failed");
					Object.assign(error, {
						issues: [{ path: ["valid"], message: "Expected boolean" }],
					});
					throw error;
				},
			};
			const { source, emitted } = makeSource({ "order.validated": schema });

			await expect(source.derive(makeParent(), "order.validated", { valid: "yes" }, "validateOrder")).rejects.toThrow(
				PayloadValidationError,
			);
			expect(emitted).toHaveLength(0);
		});
	});

	describe("fork", () => {
		it("creates a targeted copy and emits it", async () => {
			const { source, emitted } = makeSource({});
			const parent = makeParent();

			const event = await source.fork(parent, { targetAction: "sendEmail" });

			expect(event.id).toMatch(EVT_PREFIX);
			expect(event.id).not.toBe(parent.id);
			expect(event.type).toBe("order.received");
			expect(event.payload).toEqual({ orderId: "abc" });
			expect(event.correlationId).toBe("corr_xyz");
			expect(event.parentEventId).toBe("evt_parent");
			expect(event.targetAction).toBe("sendEmail");
			expect(event.state).toBe("pending");
			expect(event.emittedAt).toBeInstanceOf(Date);
			expect(emitted).toHaveLength(1);
		});

		it("does not validate the payload", async () => {
			const { source } = makeSource({});
			const parent = makeParent({ type: "nonexistent.type" });

			const event = await source.fork(parent, { targetAction: "notify" });

			expect(event.type).toBe("nonexistent.type");
			expect(event.payload).toEqual({ orderId: "abc" });
		});

		it("generates independent id and createdAt", async () => {
			const { source } = makeSource({});
			const parent = makeParent();

			const fork1 = await source.fork(parent, { targetAction: "a" });
			const fork2 = await source.fork(parent, { targetAction: "b" });

			expect(fork1.id).not.toBe(parent.id);
			expect(fork2.id).not.toBe(parent.id);
			expect(fork1.id).not.toBe(fork2.id);
		});
	});

	describe("transition", () => {
		it("emits processing with startedAt", async () => {
			const { source, emitted } = makeSource({});
			const event = makeParent();

			await source.transition(event, { state: "processing" });

			expect(emitted).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const transitioned = emitted[0]!;
			expect(transitioned.state).toBe("processing");
			expect(transitioned.startedAt).toBeInstanceOf(Date);
			expect(transitioned.emittedAt).toBeInstanceOf(Date);
		});

		it("emits done/succeeded with doneAt", async () => {
			const startedAt = new Date("2026-01-01T10:00:00Z");
			const { source, emitted } = makeSource({});
			const event = makeParent({ state: "processing", startedAt });

			await source.transition(event, { state: "done", result: "succeeded" });

			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const transitioned = emitted[0]!;
			expect(transitioned.state).toBe("done");
			expect((transitioned as { result: string }).result).toBe("succeeded");
			expect(transitioned.doneAt).toBeInstanceOf(Date);
			expect(transitioned.startedAt).toBe(startedAt);
		});

		it("emits done/failed with error and doneAt", async () => {
			const { source, emitted } = makeSource({});
			const event = makeParent({ state: "processing", startedAt: new Date() });

			await source.transition(event, { state: "done", result: "failed", error: "timeout" });

			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const transitioned = emitted[0]!;
			expect(transitioned.state).toBe("done");
			expect((transitioned as { result: string }).result).toBe("failed");
			expect((transitioned as { error: unknown }).error).toBe("timeout");
			expect(transitioned.doneAt).toBeInstanceOf(Date);
		});

		it("sets startedAt to doneAt when skipping processing", async () => {
			const { source, emitted } = makeSource({});
			const event = makeParent(); // no startedAt

			await source.transition(event, { state: "done", result: "skipped" });

			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees element exists
			const transitioned = emitted[0]!;
			expect(transitioned.startedAt).toEqual(transitioned.doneAt);
		});

		it("preserves immutability of original event", async () => {
			const { source } = makeSource({});
			const event = makeParent();

			await source.transition(event, { state: "processing" });

			expect(event.state).toBe("pending");
			expect(event.startedAt).toBeUndefined();
		});
	});
});
