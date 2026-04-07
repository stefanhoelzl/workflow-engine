import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "./index.js";

// --- Type-level tests ---
// These verify compile-time type inference. If any @ts-expect-error
// is NOT actually an error, tsc will fail.

describe("type-level: event references", () => {
	it("valid event references in triggers and actions compile", () => {
		defineWorkflow({
			events: {
				"order.received": z.object({ orderId: z.string() }),
			},
			triggers: {
				orders: {
					type: "http",
					path: "orders",
					event: "order.received",
					response: { status: 202, body: { ok: true } },
				},
			},
			actions: {
				parseOrder: {
					on: "order.received",
					// biome-ignore lint/suspicious/noEmptyBlockStatements: type-level test
					handler: async () => {},
				},
			},
		});
	});

	it("invalid trigger event reference is a compile error", () => {
		defineWorkflow({
			events: {
				"order.received": z.object({ orderId: z.string() }),
			},
			triggers: {
				orders: {
					type: "http",
					path: "orders",
					// @ts-expect-error 'order.typo' is not a valid event key
					event: "order.typo",
				},
			},
			actions: {},
		});
	});

	it("invalid action event reference is a compile error", () => {
		defineWorkflow({
			events: {
				"order.received": z.object({ orderId: z.string() }),
			},
			triggers: {},
			actions: {
				parseOrder: {
					// @ts-expect-error 'order.typo' is not a valid event key
					on: "order.typo",
					// biome-ignore lint/suspicious/noEmptyBlockStatements: type-level test
					handler: async () => {},
				},
			},
		});
	});
});

describe("type-level: action handler context", () => {
	it("ctx.event.payload is typed from consumed event schema", () => {
		defineWorkflow({
			events: {
				"order.received": z.object({ orderId: z.string() }),
			},
			triggers: {},
			actions: {
				parseOrder: {
					on: "order.received",
					handler: async (ctx) => {
						const _id: string = ctx.event.payload.orderId;
						return _id as unknown as undefined;
					},
				},
			},
		});
	});

	it("ctx.emit is never when emits is omitted", () => {
		defineWorkflow({
			events: {
				"order.received": z.object({ orderId: z.string() }),
			},
			triggers: {},
			actions: {
				parseOrder: {
					on: "order.received",
					handler: async (ctx) => {
						// emit should be never — assigning to never proves it
						const _check: never = ctx.emit;
						return _check as unknown as undefined;
					},
				},
			},
		});
	});
});

// --- Runtime tests ---

describe("defineWorkflow runtime behavior", () => {
	it("returns correct WorkflowConfig structure", () => {
		const config = defineWorkflow({
			events: {
				"order.received": z.object({ orderId: z.string() }),
				"order.parsed": z.object({ total: z.number() }),
			},
			triggers: {
				orders: {
					type: "http",
					path: "orders",
					event: "order.received",
					response: { status: 202, body: { accepted: true } },
				},
			},
			actions: {
				parseOrder: {
					on: "order.received",
					emits: ["order.parsed"],
					env: ["API_KEY"],
					// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
					handler: async () => {},
				},
			},
		});

		expect(config.events).toHaveProperty("order.received");
		expect(config.events).toHaveProperty("order.parsed");
		expect(config.triggers).toHaveLength(1);
		expect(config.actions).toHaveLength(1);
	});

	it("derives action names from object keys", () => {
		const config = defineWorkflow({
			events: {
				"test.event": z.object({}),
			},
			triggers: {},
			actions: {
				myAction: {
					on: "test.event",
					// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
					handler: async () => {},
				},
			},
		});

		expect(config.actions[0]?.name).toBe("myAction");
	});

	it("preserves action emits and env arrays", () => {
		const config = defineWorkflow({
			events: {
				"a.event": z.object({}),
				"b.event": z.object({}),
			},
			triggers: {},
			actions: {
				myAction: {
					on: "a.event",
					emits: ["b.event"],
					env: ["VAR_A", "VAR_B"],
					// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
					handler: async () => {},
				},
			},
		});

		const action = config.actions[0];
		expect(action?.emits).toEqual(["b.event"]);
		expect(action?.env).toEqual(["VAR_A", "VAR_B"]);
	});

	it("defaults emits and env to empty arrays when omitted", () => {
		const config = defineWorkflow({
			events: {
				"test.event": z.object({}),
			},
			triggers: {},
			actions: {
				myAction: {
					on: "test.event",
					// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
					handler: async () => {},
				},
			},
		});

		const action = config.actions[0];
		expect(action?.emits).toEqual([]);
		expect(action?.env).toEqual([]);
	});

	it("passes trigger definitions through to config", () => {
		const config = defineWorkflow({
			events: {
				"order.received": z.object({ orderId: z.string() }),
			},
			triggers: {
				orders: {
					type: "http",
					path: "orders",
					event: "order.received",
					response: { status: 202, body: {} },
				},
			},
			actions: {},
		});

		expect(config.triggers[0]?.event).toBe("order.received");
		expect(config.triggers[0]?.path).toBe("orders");
	});
});
