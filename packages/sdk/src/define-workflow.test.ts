import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkflow, ENV_REF, env, http } from "./index.js";

// --- Type-level tests ---
// These verify compile-time type inference. If any @ts-expect-error
// is NOT actually an error, tsc will fail.

describe("type-level: phase transitions", () => {
	it("createWorkflow() returns TriggerPhase with trigger, event, action, compile", () => {
		const wf = createWorkflow("test");
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.trigger;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.event;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.compile;
	});

	it(".trigger() stays in TriggerPhase", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.order",
			http({ path: "order" }),
		);
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.trigger;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.event;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.compile;
	});

	it(".event() transitions to EventPhase (no .trigger())", () => {
		const wf = createWorkflow("test").event(
			"order.validated",
			z.object({ orderId: z.string() }),
		);
		// @ts-expect-error trigger not available in EventPhase
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.trigger;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.event;
		// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
		wf.compile;
	});

	it("trigger -> event -> action transitions correctly", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.event("order.validated", z.object({ orderId: z.string() }))
			.action({
				on: "webhook.order",
				emits: ["order.validated"],
				handler: async () => {},
			});
	});
});

describe("type-level: unique name enforcement", () => {
	it("duplicate trigger names are a compile error", () => {
		createWorkflow("test")
			.trigger("webhook.order", http({ path: "order" }))
			// @ts-expect-error 'webhook.order' already exists in T
			.trigger("webhook.order", http({ path: "order2" }));
	});

	it("event name colliding with trigger name is a compile error", () => {
		createWorkflow("test")
			.trigger("webhook.order", http({ path: "order" }))
			// @ts-expect-error 'webhook.order' already exists in T
			.event("webhook.order", z.object({}));
	});

	it("duplicate event names are a compile error", () => {
		createWorkflow("test")
			.event("a", z.object({}))
			// @ts-expect-error 'a' already exists in E
			.event("a", z.object({}));
	});
});

describe("type-level: action handler context", () => {
	it("ctx.event.payload is typed from trigger event schema (HTTP payload shape)", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.action({
				on: "webhook.order",
				handler: async (ctx) => {
					const _id: string = ctx.event.payload.body.orderId;
					const _url: string = ctx.event.payload.url;
					const _method: string = ctx.event.payload.method;
					const _headers: Record<string, string> = ctx.event.payload.headers;
					const _params: Record<string, never> = ctx.event.payload.params;
					const _query: Record<string, never> = ctx.event.payload.query;
					return [
						_id,
						_url,
						_method,
						_headers,
						_params,
						_query,
					] as unknown as undefined;
				},
			});
	});

	it("ctx.event.payload is typed from action event schema", () => {
		createWorkflow("test")
			.event("order.validated", z.object({ orderId: z.string() }))
			.action({
				on: "order.validated",
				handler: async (ctx) => {
					const _id: string = ctx.event.payload.orderId;
					return _id as unknown as undefined;
				},
			});
	});

	it("ctx.emit validates event name and payload type when in emits", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.event("order.parsed", z.object({ total: z.number() }))
			.action({
				on: "webhook.order",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					await ctx.emit("order.parsed", { total: 42 });
				},
			});
	});

	it("ctx.emit rejects trigger event (cannot emit trigger events)", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.event("order.parsed", z.object({ total: z.number() }))
			.action({
				on: "webhook.order",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					// @ts-expect-error 'webhook.order' is a trigger event, not in emits
					await ctx.emit("webhook.order", {});
				},
			});
	});

	it("ctx.emit rejects event not in emits array", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.event("order.parsed", z.object({ total: z.number() }))
			.event("order.shipped", z.object({}))
			.action({
				on: "webhook.order",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					// @ts-expect-error 'order.shipped' not in emits
					await ctx.emit("order.shipped", {});
				},
			});
	});

	it("ctx.emit rejects unknown event name", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.event("order.parsed", z.object({ total: z.number() }))
			.action({
				on: "webhook.order",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					// @ts-expect-error 'order.typo' is not a valid event
					await ctx.emit("order.typo", {});
				},
			});
	});

	it("ctx.emit rejects wrong payload type", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.event("order.parsed", z.object({ total: z.number() }))
			.action({
				on: "webhook.order",
				emits: ["order.parsed"],
				handler: async (ctx) => {
					// @ts-expect-error wrong payload type
					await ctx.emit("order.parsed", { orderId: "abc" });
				},
			});
	});

	it("no emits declaration makes ctx.emit accept never", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.event("order.parsed", z.object({ total: z.number() }))
			.action({
				on: "webhook.order",
				handler: async (ctx) => {
					// @ts-expect-error no emits declared
					await ctx.emit("order.parsed", { total: 1 });
				},
			});
	});

	it("ctx.env narrowed to declared keys, readonly, typed as string", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.action({
				on: "webhook.order",
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
		createWorkflow("test")
			.env({ baseUrl: "https://example.com" })
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.action({
				on: "webhook.order",
				handler: async (ctx) => {
					const _url: string = ctx.env.baseUrl;
					return _url as unknown as undefined;
				},
			});
	});

	it("workflow env + action env keys are merged in ctx.env", () => {
		createWorkflow("test")
			.env({ baseUrl: "https://example.com" })
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.action({
				on: "webhook.order",
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
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.action({
				on: "webhook.order",
				handler: async (ctx) => {
					// @ts-expect-error no env declared
					// biome-ignore lint/suspicious/noUnusedExpressions: type-level test
					ctx.env.ANYTHING;
				},
			});
	});
});

describe("type-level: event references", () => {
	it("invalid action event reference is a compile error", () => {
		createWorkflow("test")
			.trigger(
				"webhook.order",
				http({ path: "order", body: z.object({ orderId: z.string() }) }),
			)
			.action({
				// @ts-expect-error 'order.typo' is not a valid event key
				on: "order.typo",
				handler: async () => {},
			});
	});
});

describe("type-level: path params inference", () => {
	it("single named param is inferred from path", () => {
		createWorkflow("test")
			.trigger("webhook.user", http({ path: "users/:userId" }))
			.action({
				on: "webhook.user",
				handler: async (ctx) => {
					const _userId: string = ctx.event.payload.params.userId;
					return _userId as unknown as undefined;
				},
			});
	});

	it("multiple named params are inferred from path", () => {
		createWorkflow("test")
			.trigger(
				"webhook.member",
				http({ path: "orgs/:orgId/members/:memberId" }),
			)
			.action({
				on: "webhook.member",
				handler: async (ctx) => {
					const _orgId: string = ctx.event.payload.params.orgId;
					const _memberId: string = ctx.event.payload.params.memberId;
					return [_orgId, _memberId] as unknown as undefined;
				},
			});
	});

	it("wildcard param is inferred from path", () => {
		createWorkflow("test")
			.trigger("webhook.files", http({ path: "files/*rest" }))
			.action({
				on: "webhook.files",
				handler: async (ctx) => {
					const _rest: string = ctx.event.payload.params.rest;
					return _rest as unknown as undefined;
				},
			});
	});

	it("static path params cannot be assigned to a specific key object", () => {
		createWorkflow("test")
			.trigger("webhook.order", http({ path: "orders" }))
			.action({
				on: "webhook.order",
				handler: async (ctx) => {
					// @ts-expect-error params has no 'userId' key for static paths
					const _typed: { userId: string } = ctx.event.payload.params;
					return _typed as unknown as undefined;
				},
			});
	});

	it("explicit params schema with matching keys compiles", () => {
		createWorkflow("test")
			.trigger(
				"webhook.user",
				http({
					path: "users/:userId",
					params: z.object({ userId: z.string() }),
				}),
			)
			.action({
				on: "webhook.user",
				handler: async (ctx) => {
					const _userId: string = ctx.event.payload.params.userId;
					return _userId as unknown as undefined;
				},
			});
	});

	it("explicit params schema with mismatched keys is a compile error", () => {
		createWorkflow("test")
			.trigger(
				"webhook.user",
				http({
					path: "users/:userId",
					// @ts-expect-error 'id' does not match path param ':userId'
					params: z.object({ id: z.string() }),
				}),
			)
			.action({
				on: "webhook.user",
				handler: async () => {},
			});
	});
});

describe("type-level: query params", () => {
	it("query schema types are inferred in action context", () => {
		createWorkflow("test")
			.trigger(
				"webhook.search",
				http({
					path: "search",
					query: z.object({ q: z.string() }),
				}),
			)
			.action({
				on: "webhook.search",
				handler: async (ctx) => {
					const _q: string = ctx.event.payload.query.q;
					return _q as unknown as undefined;
				},
			});
	});

	it("array query param types are inferred", () => {
		createWorkflow("test")
			.trigger(
				"webhook.filter",
				http({
					path: "filter",
					query: z.object({ tags: z.array(z.string()) }),
				}),
			)
			.action({
				on: "webhook.filter",
				handler: async (ctx) => {
					const _tags: string[] = ctx.event.payload.query.tags;
					return _tags as unknown as undefined;
				},
			});
	});

	it("no query schema produces empty query type", () => {
		createWorkflow("test")
			.trigger("webhook.ping", http({ path: "ping" }))
			.action({
				on: "webhook.ping",
				handler: async (ctx) => {
					// @ts-expect-error query has no 'q' key when no query schema
					const _typed: { q: string } = ctx.event.payload.query;
					return _typed as unknown as undefined;
				},
			});
	});
});

// --- Runtime tests ---

describe("workflow builder runtime behavior", () => {
	it("compile returns correct structure with trigger-owned and action-owned events", () => {
		const wf = createWorkflow("test")
			.trigger(
				"webhook.order",
				http({
					path: "orders",
					body: z.object({ orderId: z.string() }),
					response: { status: 202, body: { accepted: true } },
				}),
			)
			.event("order.parsed", z.object({ total: z.number() }));

		wf.action({
			on: "webhook.order",
			emits: ["order.parsed"],
			env: { apiKey: "test" },
			handler: async () => {},
		});

		const compiled = wf.compile();

		expect(compiled.name).toBe("test");
		expect(compiled.events).toHaveLength(2);
		const eventNames = compiled.events.map((e) => e.name);
		expect(eventNames).toContain("webhook.order");
		expect(eventNames).toContain("order.parsed");

		const triggerEvent = compiled.events.find(
			(e) => e.name === "webhook.order",
		);
		expect(triggerEvent?.schema).toHaveProperty("type", "object");
		const props = (triggerEvent?.schema as Record<string, unknown>)
			.properties as Record<string, unknown>;
		expect(props).toHaveProperty("body");
		expect(props).toHaveProperty("headers");
		expect(props).toHaveProperty("url");
		expect(props).toHaveProperty("method");

		expect(compiled.triggers).toHaveLength(1);
		expect(compiled.actions).toHaveLength(1);
	});

	it("trigger entries have no event field", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.order",
			http({
				path: "orders",
				body: z.object({ orderId: z.string() }),
				response: { status: 202, body: {} },
			}),
		);

		wf.action({ on: "webhook.order", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.triggers[0]?.name).toBe("webhook.order");
		expect(compiled.triggers[0]?.path).toBe("orders");
		expect(compiled.triggers[0]).not.toHaveProperty("event");
	});

	it("action() returns the handler whose reference matches compile output", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.test",
			http({ path: "test" }),
		);

		const handler = async () => {};
		const returned = wf.action({ on: "webhook.test", handler });

		// vite-plugin identifies the named export for each action via reference
		// equality against compile output (`fn === action.handler`). The runtime
		// ctx.emit wrapping lives in the sdk-stub used at bundle time; the real
		// SDK just threads the raw handler through.
		expect(returned).toBe(handler);
		const compiled = wf.compile();
		expect(compiled.actions[0]?.handler).toBe(handler);
	});

	it("preserves action emits and env", () => {
		const wf = createWorkflow("test")
			.trigger("webhook.a", http({ path: "a" }))
			.event("b.event", z.object({}));

		wf.action({
			on: "webhook.a",
			emits: ["b.event"],
			env: { varA: "a", varB: "b" },
			handler: async () => {},
		});

		const compiled = wf.compile();
		const action = compiled.actions[0];
		expect(action?.emits).toEqual(["b.event"]);
		expect(action?.env).toEqual({ varA: "a", varB: "b" });
	});

	it("defaults emits and env to empty when omitted", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.test",
			http({ path: "test" }),
		);

		wf.action({ on: "webhook.test", handler: async () => {} });

		const compiled = wf.compile();
		const action = compiled.actions[0];
		expect(action?.emits).toEqual([]);
		expect(action?.env).toEqual({});
	});

	it("optional action name is preserved in compile output", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.test",
			http({ path: "test" }),
		);

		wf.action({
			name: "customName",
			on: "webhook.test",
			handler: async () => {},
		});

		const compiled = wf.compile();
		expect(compiled.actions[0]?.name).toBe("customName");
	});

	it("action name is undefined when not provided", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.test",
			http({ path: "test" }),
		);

		wf.action({ on: "webhook.test", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.name).toBeUndefined();
	});

	it("compile handler references match action return values", () => {
		const wf = createWorkflow("test")
			.trigger("webhook.a", http({ path: "a" }))
			.event("b", z.object({}));

		const handlerA = wf.action({ on: "webhook.a", handler: async () => {} });
		const handlerB = wf.action({ on: "b", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.handler).toBe(handlerA);
		expect(compiled.actions[1]?.handler).toBe(handlerB);
	});

	it("event schemas are valid JSON Schema", () => {
		const wf = createWorkflow("test").event(
			"test.event",
			z.object({
				id: z.string(),
				count: z.number(),
				status: z.enum(["active", "inactive"]),
				label: z.string().nullable(),
			}),
		);

		const compiled = wf.compile();
		const schema = compiled.events[0]?.schema as Record<string, unknown>;

		expect(schema).toHaveProperty("type", "object");
		expect(schema).toHaveProperty("properties");
		expect(schema).toHaveProperty("required");
	});

	it("http() with body schema generates wrapped JSON Schema", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.test",
			http({
				path: "test",
				body: z.object({ id: z.string() }),
			}),
		);

		const compiled = wf.compile();
		const event = compiled.events.find((e) => e.name === "webhook.test");
		const schema = event?.schema as Record<string, unknown>;
		const properties = schema.properties as Record<string, unknown>;

		expect(properties).toHaveProperty("body");
		expect(properties).toHaveProperty("headers");
		expect(properties).toHaveProperty("url");
		expect(properties).toHaveProperty("method");
		expect(properties).toHaveProperty("params");
		expect(properties).toHaveProperty("query");
	});

	it("static path produces params: [] in trigger config", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.order",
			http({ path: "orders" }),
		);

		wf.action({ on: "webhook.order", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.triggers[0]?.params).toEqual([]);
	});

	it("parameterized path produces correct param names in trigger config", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.member",
			http({ path: "orgs/:orgId/members/:memberId" }),
		);

		wf.action({ on: "webhook.member", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.triggers[0]?.params).toEqual(["orgId", "memberId"]);
	});

	it("wildcard path produces correct param name in trigger config", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.files",
			http({ path: "files/*rest" }),
		);

		wf.action({ on: "webhook.files", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.triggers[0]?.params).toEqual(["rest"]);
	});

	it("http() without body schema defaults to unknown", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.ping",
			http({ path: "ping", method: "GET" }),
		);

		const compiled = wf.compile();
		const event = compiled.events.find((e) => e.name === "webhook.ping");
		expect(event).toBeDefined();
		const schema = event?.schema as Record<string, unknown>;
		expect(schema).toHaveProperty("type", "object");
	});

	it("http() with response config passes through to trigger", () => {
		const wf = createWorkflow("test").trigger(
			"webhook.test",
			http({
				path: "test",
				response: { status: 202, body: { accepted: true } },
			}),
		);

		const compiled = wf.compile();
		expect(compiled.triggers[0]?.response).toEqual({
			status: 202,
			body: { accepted: true },
		});
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
		const wf = createWorkflow("test", { apiUrl: "https://api.example.com" })
			.env({ apiUrl: env() })
			.trigger("webhook.e", http({ path: "e" }));

		wf.action({ on: "webhook.e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({
			apiUrl: "https://api.example.com",
		});
	});

	it("resolves env() with explicit name from envSource", () => {
		const wf = createWorkflow("test", { myApi: "https://api.example.com" })
			.env({ apiUrl: env("myApi") })
			.trigger("webhook.e", http({ path: "e" }));

		wf.action({ on: "webhook.e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({
			apiUrl: "https://api.example.com",
		});
	});

	it("uses default when env var is missing", () => {
		const wf = createWorkflow("test", {})
			.env({ apiUrl: env({ default: "http://localhost" }) })
			.trigger("webhook.e", http({ path: "e" }));

		wf.action({ on: "webhook.e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ apiUrl: "http://localhost" });
	});

	it("throws when env var is missing without default", () => {
		expect(() => {
			createWorkflow("test", {}).env({ apiUrl: env() });
		}).toThrow("Missing environment variable: apiUrl");
	});

	it("keeps plain string values as-is", () => {
		const wf = createWorkflow("test", {})
			.env({ apiUrl: "https://hardcoded.example.com" })
			.trigger("webhook.e", http({ path: "e" }));

		wf.action({ on: "webhook.e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({
			apiUrl: "https://hardcoded.example.com",
		});
	});

	it("merges workflow env and action env (action wins on conflict)", () => {
		const wf = createWorkflow("test", {})
			.env({ a: "workflow-a", b: "workflow-b" })
			.trigger("webhook.e", http({ path: "e" }));

		wf.action({
			on: "webhook.e",
			env: { b: "action-b", c: "action-c" },
			handler: async () => {},
		});

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({
			a: "workflow-a",
			b: "action-b",
			c: "action-c",
		});
	});

	it("action without env inherits workflow env", () => {
		const wf = createWorkflow("test", {})
			.env({ base: "https://example.com" })
			.trigger("webhook.e", http({ path: "e" }));

		wf.action({ on: "webhook.e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ base: "https://example.com" });
	});

	it("action env resolves env() markers from envSource", () => {
		const wf = createWorkflow("test", { secret: "s3cr3t" }).trigger(
			"webhook.e",
			http({ path: "e" }),
		);

		wf.action({
			on: "webhook.e",
			env: { secret: env() },
			handler: async () => {},
		});

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({ secret: "s3cr3t" });
	});

	it("no env at any level produces empty env", () => {
		const wf = createWorkflow("test").trigger("webhook.e", http({ path: "e" }));

		wf.action({ on: "webhook.e", handler: async () => {} });

		const compiled = wf.compile();
		expect(compiled.actions[0]?.env).toEqual({});
	});
});

describe("http() query param coercion", () => {
	function parsePayload(
		triggerDef: { schema: { parse: (data: unknown) => unknown } },
		payload: unknown,
	): unknown {
		return triggerDef.schema.parse(payload);
	}

	const basePayload = {
		body: {},
		headers: {},
		url: "https://example.com",
		method: "POST",
		params: {},
	};

	it("string field takes last value from array", () => {
		const trigger = http({
			path: "test",
			query: z.object({ source: z.string() }),
		});

		const result = parsePayload(trigger, {
			...basePayload,
			query: { source: ["a", "b"] },
		});
		expect(result).toHaveProperty("query", { source: "b" });
	});

	it("string field passes through plain string", () => {
		const trigger = http({
			path: "test",
			query: z.object({ source: z.string() }),
		});

		const result = parsePayload(trigger, {
			...basePayload,
			query: { source: "direct" },
		});
		expect(result).toHaveProperty("query", { source: "direct" });
	});

	it("array field keeps array as-is", () => {
		const trigger = http({
			path: "test",
			query: z.object({ tags: z.array(z.string()) }),
		});

		const result = parsePayload(trigger, {
			...basePayload,
			query: { tags: ["a", "b"] },
		});
		expect(result).toHaveProperty("query", { tags: ["a", "b"] });
	});

	it("array field coerces single value to array", () => {
		const trigger = http({
			path: "test",
			query: z.object({ tags: z.array(z.string()) }),
		});

		const result = parsePayload(trigger, {
			...basePayload,
			query: { tags: "solo" },
		});
		expect(result).toHaveProperty("query", { tags: ["solo"] });
	});

	it("empty query defaults to empty object", () => {
		const trigger = http({ path: "test" });

		const result = parsePayload(trigger, {
			...basePayload,
			query: {},
		});
		expect(result).toHaveProperty("query", {});
	});

	it("mixed string and array fields coerce correctly", () => {
		const trigger = http({
			path: "test",
			query: z.object({
				source: z.string(),
				tags: z.array(z.string()),
			}),
		});

		const result = parsePayload(trigger, {
			...basePayload,
			query: {
				source: ["shopify", "stripe"],
				tags: ["urgent"],
			},
		});
		expect(result).toHaveProperty("query", {
			source: "stripe",
			tags: ["urgent"],
		});
	});
});
