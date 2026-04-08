import { describe, expect, it } from "vitest";
import { z } from "zod";
import { workflow } from "./index.js";

// --- Type-level tests ---
// These verify compile-time type inference. If any @ts-expect-error
// is NOT actually an error, tsc will fail.

describe("type-level: event references", () => {
	it("valid event references in triggers and actions compile", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				event: "order.received",
				response: { status: 202, body: { ok: true } },
			})
			.action("parseOrder", {
				on: "order.received",
				// biome-ignore lint/suspicious/noEmptyBlockStatements: type-level test
				handler: async () => {},
			})
			.build();
	});

	it("invalid trigger event reference is a compile error", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				// @ts-expect-error 'order.typo' is not a valid event key
				event: "order.typo",
			})
			.action("parseOrder", {
				on: "order.received",
				// biome-ignore lint/suspicious/noEmptyBlockStatements: type-level test
				handler: async () => {},
			})
			.build();
	});

	it("invalid action event reference is a compile error", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				event: "order.received",
			})
			.action("parseOrder", {
				// @ts-expect-error 'order.typo' is not a valid event key
				on: "order.typo",
				// biome-ignore lint/suspicious/noEmptyBlockStatements: type-level test
				handler: async () => {},
			})
			.build();
	});
});

describe("type-level: action handler context", () => {
	it("ctx.event.payload is typed from consumed event schema", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" })
			.action("parseOrder", {
				on: "order.received",
				handler: async (ctx) => {
					const _id: string = ctx.event.payload.orderId;
					return _id as unknown as undefined;
				},
			})
			.build();
	});

	it("ctx.emit validates event name and payload type when in emits", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" })
			.action("parseOrder", {
				on: "order.received",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					// valid emit compiles
					ctx.emit("order.parsed", { total: 42 });
				},
			})
			.build();
	});

	it("ctx.emit rejects event not in emits array", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" })
			.action("parseOrder", {
				on: "order.received",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					// @ts-expect-error 'order.received' is not in emits
					ctx.emit("order.received", { orderId: "a" });
				},
			})
			.build();
	});

	it("ctx.emit rejects unknown event name", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" })
			.action("parseOrder", {
				on: "order.received",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					// @ts-expect-error 'order.typo' is not a valid event
					ctx.emit("order.typo", {});
				},
			})
			.build();
	});

	it("ctx.emit rejects wrong payload type", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" })
			.action("parseOrder", {
				on: "order.received",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					// @ts-expect-error wrong payload type
					ctx.emit("order.parsed", { orderId: "abc" });
				},
			})
			.build();
	});

	it("no emits declaration makes ctx.emit accept never", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" })
			.action("sink", {
				on: "order.received",
				handler: async (ctx) => {
					// @ts-expect-error no emits declared
					ctx.emit("order.parsed", { total: 1 });
				},
			})
			.build();
	});

	it("ctx.env narrowed to declared keys, readonly, typed as string", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" })
			.action("sender", {
				on: "order.received",
				env: ["API_KEY"],
				handler: async (ctx) => {
					const _k: string = ctx.env.API_KEY;
					// @ts-expect-error SECRET not declared
					// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
					ctx.env.SECRET;
					// @ts-expect-error readonly
					ctx.env.API_KEY = "x";
					return _k as unknown as undefined;
				},
			})
			.build();
	});

	it("no env declaration makes ctx.env an empty readonly record", () => {
		workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" })
			.action("noEnv", {
				on: "order.received",
				handler: async (ctx) => {
					// @ts-expect-error no env declared
					// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
					ctx.env.ANYTHING;
				},
			})
			.build();
	});
});

describe("type-level: phase ordering", () => {
	it("workflow() only exposes event()", () => {
		const start = workflow();
		// @ts-expect-error trigger not available on StartPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		start.trigger;
		// @ts-expect-error action not available on StartPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		start.action;
		// @ts-expect-error build not available on StartPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		start.build;
	});

	it("event phase exposes event() and trigger() but not action() or build()", () => {
		const eventPhase = workflow().event("a", z.object({}));
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		eventPhase.event;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		eventPhase.trigger;
		// @ts-expect-error action not available on EventPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		eventPhase.action;
		// @ts-expect-error build not available on EventPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		eventPhase.build;
	});

	it("trigger phase exposes trigger() and action() but not event() or build()", () => {
		const triggerPhase = workflow()
			.event("a", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "a" });
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		triggerPhase.trigger;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		triggerPhase.action;
		// @ts-expect-error event not available on TriggerPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		triggerPhase.event;
		// @ts-expect-error build not available on TriggerPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		triggerPhase.build;
	});

	it("action phase exposes action() and build() but not event() or trigger()", () => {
		const actionPhase = workflow()
			.event("a", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "a" })
			// biome-ignore lint/suspicious/noEmptyBlockStatements: type-level test
			.action("x", { on: "a", handler: async () => {} });
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		actionPhase.action;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		actionPhase.build;
		// @ts-expect-error event not available on ActionPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		actionPhase.event;
		// @ts-expect-error trigger not available on ActionPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		actionPhase.trigger;
	});
});

// --- Runtime tests ---

describe("workflow builder runtime behavior", () => {
	it("returns correct WorkflowConfig structure", () => {
		const config = workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				event: "order.received",
				response: { status: 202, body: { accepted: true } },
			})
			.action("parseOrder", {
				on: "order.received",
				emits: ["order.parsed"],
				env: ["API_KEY"],
				// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
				handler: async () => {},
			})
			.build();

		expect(config.events).toHaveProperty("order.received");
		expect(config.events).toHaveProperty("order.parsed");
		expect(config.triggers).toHaveLength(1);
		expect(config.actions).toHaveLength(1);
	});

	it("derives action names from .action() first argument", () => {
		const config = workflow()
			.event("test.event", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "test.event" })
			.action("myAction", {
				on: "test.event",
				// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
				handler: async () => {},
			})
			.build();

		expect(config.actions[0]?.name).toBe("myAction");
	});

	it("preserves action emits and env arrays", () => {
		const config = workflow()
			.event("a.event", z.object({}))
			.event("b.event", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "a.event" })
			.action("myAction", {
				on: "a.event",
				emits: ["b.event"],
				env: ["VAR_A", "VAR_B"],
				// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
				handler: async () => {},
			})
			.build();

		const action = config.actions[0];
		expect(action?.emits).toEqual(["b.event"]);
		expect(action?.env).toEqual(["VAR_A", "VAR_B"]);
	});

	it("defaults emits and env to empty arrays when omitted", () => {
		const config = workflow()
			.event("test.event", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "test.event" })
			.action("myAction", {
				on: "test.event",
				// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
				handler: async () => {},
			})
			.build();

		const action = config.actions[0];
		expect(action?.emits).toEqual([]);
		expect(action?.env).toEqual([]);
	});

	it("passes trigger definitions through to config", () => {
		const config = workflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				event: "order.received",
				response: { status: 202, body: {} },
			})
			.action("a", {
				on: "order.received",
				// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
				handler: async () => {},
			})
			.build();

		expect(config.triggers[0]?.event).toBe("order.received");
		expect(config.triggers[0]?.path).toBe("orders");
	});
});
