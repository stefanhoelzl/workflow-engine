import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkflow, env, ENV_REF } from "./index.js";

// --- Type-level tests ---
// These verify compile-time type inference. If any @ts-expect-error
// is NOT actually an error, tsc will fail.

describe("type-level: event references", () => {
	it("valid event references in triggers and actions compile", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				event: "order.received",
				response: { status: 202, body: { ok: true } },
			});

		wf.action({
			on: "order.received",
			// biome-ignore lint/suspicious/noEmptyBlockStatements: type-level test
			handler: async () => {},
		});
	});

	it("invalid trigger event reference is a compile error", () => {
		createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				// @ts-expect-error 'order.typo' is not a valid event key
				event: "order.typo",
			});
	});

	it("invalid action event reference is a compile error", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				event: "order.received",
			});

		wf.action({
			// @ts-expect-error 'order.typo' is not a valid event key
			on: "order.typo",
			// biome-ignore lint/suspicious/noEmptyBlockStatements: type-level test
			handler: async () => {},
		});
	});
});

describe("type-level: action handler context", () => {
	it("ctx.event.payload is typed from consumed event schema", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			handler: async (ctx) => {
				const _id: string = ctx.event.payload.orderId;
				return _id as unknown as undefined;
			},
		});
	});

	it("ctx.emit validates event name and payload type when in emits", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			emits: ["order.parsed"],
			handler: async (ctx) => {
				// valid emit compiles
				ctx.emit("order.parsed", { total: 42 });
			},
		});
	});

	it("ctx.emit rejects event not in emits array", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			emits: ["order.parsed"],
			handler: async (ctx) => {
				// @ts-expect-error 'order.received' is not in emits
				ctx.emit("order.received", { orderId: "a" });
			},
		});
	});

	it("ctx.emit rejects unknown event name", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			emits: ["order.parsed"],
			handler: async (ctx) => {
				// @ts-expect-error 'order.typo' is not a valid event
				ctx.emit("order.typo", {});
			},
		});
	});

	it("ctx.emit rejects wrong payload type", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			emits: ["order.parsed"],
			handler: async (ctx) => {
				// @ts-expect-error wrong payload type
				ctx.emit("order.parsed", { orderId: "abc" });
			},
		});
	});

	it("no emits declaration makes ctx.emit accept never", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			handler: async (ctx) => {
				// @ts-expect-error no emits declared
				ctx.emit("order.parsed", { total: 1 });
			},
		});
	});

	it("ctx.env narrowed to declared keys, readonly, typed as string", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			env: { apiKey: "secret" },
			handler: async (ctx) => {
				const _k: string = ctx.env.apiKey;
				// @ts-expect-error secret not declared
				// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
				ctx.env.secret;
				// @ts-expect-error readonly
				ctx.env.apiKey = "x";
				return _k as unknown as undefined;
			},
		});
	});

	it("workflow-level env is available in action ctx.env", () => {
		const wf = createWorkflow()
			.env({ baseUrl: "https://example.com" })
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			handler: async (ctx) => {
				const _url: string = ctx.env.baseUrl;
				return _url as unknown as undefined;
			},
		});
	});

	it("workflow env + action env keys are merged in ctx.env", () => {
		const wf = createWorkflow()
			.env({ baseUrl: "https://example.com" })
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			env: { apiKey: "secret" },
			handler: async (ctx) => {
				const _url: string = ctx.env.baseUrl;
				const _key: string = ctx.env.apiKey;
				// @ts-expect-error unknown not declared
				// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
				ctx.env.unknown;
				return [_url, _key] as unknown as undefined;
			},
		});
	});

	it("no env declaration makes ctx.env an empty readonly record", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("t", { type: "http", path: "t", event: "order.received" });

		wf.action({
			on: "order.received",
			handler: async (ctx) => {
				// @ts-expect-error no env declared
				// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
				ctx.env.ANYTHING;
			},
		});
	});
});

describe("type-level: builder exposes all methods", () => {
	it("createWorkflow() exposes event, trigger, action, and compile", () => {
		const wf = createWorkflow()
			.event("a", z.object({}));
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.event;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.trigger;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.action;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.compile;
	});
});

// --- Runtime tests ---

describe("workflow builder runtime behavior", () => {
	it("compile returns correct structure with JSON Schema events", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.event("order.parsed", z.object({ total: z.number() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				event: "order.received",
				response: { status: 202, body: { accepted: true } },
			});

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "order.received", emits: ["order.parsed"], env: { apiKey: "test" }, handler: async () => {} });

		const compiled = wf.compile();

		expect(compiled.events).toHaveLength(2);
		expect(compiled.events[0]?.name).toBe("order.received");
		expect(compiled.events[0]?.schema).toHaveProperty("type", "object");
		expect(compiled.events[1]?.name).toBe("order.parsed");
		expect(compiled.triggers).toHaveLength(1);
		expect(compiled.actions).toHaveLength(1);
	});

	it("action() returns the handler function directly (reference equality)", () => {
		const wf = createWorkflow()
			.event("test.event", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "test.event" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		const handler = async () => {};
		const returned = wf.action({ on: "test.event", handler });

		expect(returned).toBe(handler);
	});

	it("preserves action emits and env arrays", () => {
		const wf = createWorkflow()
			.event("a.event", z.object({}))
			.event("b.event", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "a.event" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "a.event", emits: ["b.event"], env: { varA: "a", varB: "b" }, handler: async () => {} });

		const compiled = wf.compile();
		const action = compiled.actions[0];
		expect(action?.emits).toEqual(["b.event"]);
		expect(action?.env).toEqual({ varA: "a", varB: "b" });
	});

	it("defaults emits and env to empty arrays when omitted", () => {
		const wf = createWorkflow()
			.event("test.event", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "test.event" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "test.event", handler: async () => {} });

		const compiled = wf.compile();
		const action = compiled.actions[0];
		expect(action?.emits).toEqual([]);
		expect(action?.env).toEqual({});
	});

	it("passes trigger definitions through to compile output", () => {
		const wf = createWorkflow()
			.event("order.received", z.object({ orderId: z.string() }))
			.trigger("orders", {
				type: "http",
				path: "orders",
				event: "order.received",
				response: { status: 202, body: {} },
			});

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "order.received", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.triggers[0]?.name).toBe("orders");
		expect(compiled.triggers[0]?.event).toBe("order.received");
		expect(compiled.triggers[0]?.path).toBe("orders");
	});

	it("optional action name is preserved in compile output", () => {
		const wf = createWorkflow()
			.event("test.event", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "test.event" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ name: "customName", on: "test.event", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.name).toBe("customName");
	});

	it("action name is undefined when not provided", () => {
		const wf = createWorkflow()
			.event("test.event", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "test.event" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "test.event", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.name).toBeUndefined();
	});

	it("compile handler references match action return values", () => {
		const wf = createWorkflow()
			.event("a", z.object({}))
			.event("b", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "a" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		const handlerA = wf.action({ on: "a", handler: async () => {} });
		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		const handlerB = wf.action({ on: "b", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.handler).toBe(handlerA);
		expect(compiled.actions[1]?.handler).toBe(handlerB);
	});

	it("event schemas are valid JSON Schema", () => {
		const wf = createWorkflow()
			.event("test.event", z.object({
				id: z.string(),
				count: z.number(),
				status: z.enum(["active", "inactive"]),
				label: z.string().nullable(),
			}))
			.trigger("t", { type: "http", path: "t", event: "test.event" });

		const compiled = wf.compile();
		const schema = compiled.events[0]?.schema as Record<string, unknown>;

		expect(schema).toHaveProperty("type", "object");
		expect(schema).toHaveProperty("properties");
		expect(schema).toHaveProperty("required");
	});
});

// --- env() and EnvRef tests ---

describe("env() helper", () => {
	it("env() with no arguments returns marker with undefined name and default", () => {
		const ref = env();
		expect(ENV_REF in ref).toBe(true);
		expect(ref.name).toBeUndefined();
		expect(ref.default).toBeUndefined();
	});

	it("env(name) returns marker with explicit name", () => {
		const ref = env("MY_VAR");
		expect(ref.name).toBe("MY_VAR");
		expect(ref.default).toBeUndefined();
	});

	it("env({ default }) returns marker with default", () => {
		const ref = env({ default: "fallback" });
		expect(ref.name).toBeUndefined();
		expect(ref.default).toBe("fallback");
	});

	it("env(name, { default }) returns marker with both", () => {
		const ref = env("MY_VAR", { default: "fallback" });
		expect(ref.name).toBe("MY_VAR");
		expect(ref.default).toBe("fallback");
	});

	it("plain objects without ENV_REF symbol are not env refs", () => {
		const plain = { name: "FOO" };
		expect(ENV_REF in plain).toBe(false);
	});
});

describe("workflow env resolution", () => {
	it("resolves env() markers from envSource using object key", () => {
		const wf = createWorkflow({ apiUrl: "https://api.example.com" })
			.env({ apiUrl: env() })
			.event("e", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "e" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ apiUrl: "https://api.example.com" });
	});

	it("resolves env() with explicit name from envSource", () => {
		const wf = createWorkflow({ myApi: "https://api.example.com" })
			.env({ apiUrl: env("myApi") })
			.event("e", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "e" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ apiUrl: "https://api.example.com" });
	});

	it("uses default when env var is missing", () => {
		const wf = createWorkflow({})
			.env({ apiUrl: env({ default: "http://localhost" }) })
			.event("e", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "e" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ apiUrl: "http://localhost" });
	});

	it("throws when env var is missing without default", () => {
		expect(() => {
			createWorkflow({}).env({ apiUrl: env() });
		}).toThrow("Missing environment variable: apiUrl");
	});

	it("keeps plain string values as-is", () => {
		const wf = createWorkflow({})
			.env({ apiUrl: "https://hardcoded.example.com" })
			.event("e", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "e" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ apiUrl: "https://hardcoded.example.com" });
	});

	it("merges workflow env and action env (action wins on conflict)", () => {
		const wf = createWorkflow({})
			.env({ a: "workflow-a", b: "workflow-b" })
			.event("e", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "e" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "e", env: { b: "action-b", c: "action-c" }, handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ a: "workflow-a", b: "action-b", c: "action-c" });
	});

	it("action without env inherits workflow env", () => {
		const wf = createWorkflow({})
			.env({ base: "https://example.com" })
			.event("e", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "e" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ base: "https://example.com" });
	});

	it("action env resolves env() markers from envSource", () => {
		const wf = createWorkflow({ secret: "s3cr3t" })
			.event("e", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "e" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "e", env: { secret: env() }, handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ secret: "s3cr3t" });
	});

	it("no env at any level produces empty env", () => {
		const wf = createWorkflow()
			.event("e", z.object({}))
			.trigger("t", { type: "http", path: "t", event: "e" });

		// biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
		wf.action({ on: "e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({});
	});
});
