import { describe, expect, it } from "vitest";
import { PayloadValidationError } from "./context/errors.js";
import type { RuntimeEvent } from "./event-bus/index.js";
import { createEventFactory } from "./event-factory.js";

const EVT_PREFIX = /^evt_/;

const passthroughSchema = { parse: (d: unknown) => d };

function makeParent(overrides: Record<string, unknown> = {}): RuntimeEvent {
	return {
		id: "evt_parent",
		type: "order.received",
		payload: { orderId: "abc" },
		correlationId: "corr_xyz",
		createdAt: new Date(),
		state: "pending",
		sourceType: "trigger",
		sourceName: "orders",
		...overrides,
	} as RuntimeEvent;
}

describe("createEventFactory", () => {
	describe("create", () => {
		it("returns a pending RuntimeEvent with validated payload", () => {
			const factory = createEventFactory({ "order.received": passthroughSchema });

			const event = factory.create("order.received", { orderId: "abc" }, "orders");

			expect(event.id).toMatch(EVT_PREFIX);
			expect(event.type).toBe("order.received");
			expect(event.payload).toEqual({ orderId: "abc" });
			expect(event.correlationId).toBeDefined();
			expect(event.createdAt).toBeInstanceOf(Date);
			expect(event.state).toBe("pending");
			expect(event.parentEventId).toBeUndefined();
			expect(event.targetAction).toBeUndefined();
			expect(event.sourceType).toBe("trigger");
			expect(event.sourceName).toBe("orders");
		});

		it("uses parsed output from schema", () => {
			const schema = {
				parse: (d: unknown) => ({ orderId: String((d as Record<string, unknown>).orderId) }),
			};
			const factory = createEventFactory({ "order.received": schema });

			const event = factory.create("order.received", { orderId: "abc", extra: true }, "orders");

			expect(event.payload).toEqual({ orderId: "abc" });
		});

		it("throws PayloadValidationError for invalid payload", () => {
			const schema = {
				parse: () => {
					const error = new Error("validation failed");
					Object.assign(error, {
						issues: [{ path: ["orderId"], message: "Expected string" }],
					});
					throw error;
				},
			};
			const factory = createEventFactory({ "order.received": schema });

			expect(() => factory.create("order.received", { orderId: 123 }, "orders")).toThrow(
				PayloadValidationError,
			);
		});

		it("throws PayloadValidationError for unknown event type", () => {
			const factory = createEventFactory({});

			try {
				factory.create("order.unknown", {}, "orders");
				expect.unreachable("should throw");
			} catch (e) {
				expect(e).toBeInstanceOf(PayloadValidationError);
				expect((e as PayloadValidationError).eventType).toBe("order.unknown");
				expect((e as PayloadValidationError).issues).toEqual([]);
			}
		});
	});

	describe("derive", () => {
		it("returns a child event inheriting correlationId and setting parentEventId", () => {
			const factory = createEventFactory({ "order.validated": passthroughSchema });
			const parent = makeParent();

			const event = factory.derive(parent, "order.validated", { valid: true }, "validate-order");

			expect(event.id).toMatch(EVT_PREFIX);
			expect(event.id).not.toBe(parent.id);
			expect(event.type).toBe("order.validated");
			expect(event.payload).toEqual({ valid: true });
			expect(event.correlationId).toBe("corr_xyz");
			expect(event.parentEventId).toBe("evt_parent");
			expect(event.state).toBe("pending");
			expect(event.targetAction).toBeUndefined();
			expect(event.sourceType).toBe("action");
			expect(event.sourceName).toBe("validate-order");
		});

		it("validates the payload", () => {
			const schema = {
				parse: () => {
					const error = new Error("validation failed");
					Object.assign(error, {
						issues: [{ path: ["valid"], message: "Expected boolean" }],
					});
					throw error;
				},
			};
			const factory = createEventFactory({ "order.validated": schema });

			expect(() => factory.derive(makeParent(), "order.validated", { valid: "yes" }, "validate-order")).toThrow(
				PayloadValidationError,
			);
		});
	});

	describe("fork", () => {
		it("creates a targeted copy with parentEventId", () => {
			const factory = createEventFactory({});
			const parent = makeParent();

			const event = factory.fork(parent, { targetAction: "sendEmail" });

			expect(event.id).toMatch(EVT_PREFIX);
			expect(event.id).not.toBe(parent.id);
			expect(event.type).toBe("order.received");
			expect(event.payload).toEqual({ orderId: "abc" });
			expect(event.correlationId).toBe("corr_xyz");
			expect(event.parentEventId).toBe("evt_parent");
			expect(event.targetAction).toBe("sendEmail");
			expect(event.state).toBe("pending");
			expect(event.createdAt).toBeInstanceOf(Date);
			expect(event.sourceType).toBe("trigger");
			expect(event.sourceName).toBe("orders");
		});

		it("does not validate the payload", () => {
			// factory has no schemas — if fork validated, it would throw
			const factory = createEventFactory({});
			const parent = makeParent({ type: "nonexistent.type" });

			const event = factory.fork(parent, { targetAction: "notify" });

			expect(event.type).toBe("nonexistent.type");
			expect(event.payload).toEqual({ orderId: "abc" });
		});

		it("generates independent id and createdAt", () => {
			const factory = createEventFactory({});
			const parent = makeParent();

			const fork1 = factory.fork(parent, { targetAction: "a" });
			const fork2 = factory.fork(parent, { targetAction: "b" });

			expect(fork1.id).not.toBe(parent.id);
			expect(fork2.id).not.toBe(parent.id);
			expect(fork1.id).not.toBe(fork2.id);
		});
	});
});
