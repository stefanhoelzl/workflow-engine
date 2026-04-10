import { beforeAll, describe, expect, it, vi } from "vitest";
import { ActionContext } from "../context/index.js";
import { createLogger } from "../logger.js";
import { createSandbox } from "./index.js";
import type { Sandbox } from "./index.js";

const silentLogger = createLogger("test", { level: "silent" });

function makeCtx(
	overrides: {
		emit?: ActionContext["emit"];
		fetch?: typeof globalThis.fetch;
		env?: Record<string, string>;
		payload?: unknown;
	} = {},
): ActionContext {
	const event = {
		id: "evt_1",
		type: "test.event",
		payload: overrides.payload ?? { key: "value" },
		correlationId: "corr_1",
		createdAt: new Date(),
		emittedAt: new Date(),
		state: "processing" as const,
		sourceType: "trigger" as const,
		sourceName: "test",
	};
	return new ActionContext(
		event,
		overrides.emit ??
			vi.fn(async () => {
				/* no-op */
			}),
		overrides.fetch ?? (vi.fn() as unknown as typeof globalThis.fetch),
		overrides.env ?? {},
		silentLogger,
	);
}

let sandbox: Sandbox;

// Initialize sandbox once — WASM module is shared across tests
beforeAll(async () => {
	sandbox = await createSandbox();
});

describe("sandbox isolation", () => {
	it("action code cannot access process", async () => {
		const result = await sandbox.spawn(
			"export default async (ctx) => { process.exit(1); }",
			makeCtx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("process");
		}
	});

	it("action code cannot access require", async () => {
		const result = await sandbox.spawn(
			'export default async (ctx) => { require("fs"); }',
			makeCtx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("require");
		}
	});

	it("action code cannot access global fetch", async () => {
		const result = await sandbox.spawn(
			'export default async (ctx) => { fetch("http://example.com"); }',
			makeCtx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("fetch");
		}
	});

	it("action code cannot access globalThis.constructor to escape", async () => {
		const result = await sandbox.spawn(
			"export default async (ctx) => { globalThis.constructor.constructor('return this')().process.exit(1); }",
			makeCtx(),
		);
		// QuickJS doesn't allow constructor-based escapes from WASM
		expect(result.ok).toBe(false);
	});
});

describe("sandbox results", () => {
	it("successful execution returns ok: true", async () => {
		const result = await sandbox.spawn(
			"export default async (ctx) => { }",
			makeCtx(),
		);
		expect(result).toEqual({ ok: true });
	});

	it("thrown error returns ok: false with message and stack", async () => {
		const result = await sandbox.spawn(
			'export default async (ctx) => { throw new Error("something broke"); }',
			makeCtx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("something broke");
			expect(result.error.stack).toBeDefined();
		}
	});

	it("rejected promise returns ok: false", async () => {
		const result = await sandbox.spawn(
			'export default async (ctx) => { return Promise.reject(new Error("rejected")); }',
			makeCtx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("rejected");
		}
	});
});

describe("ctx bridge", () => {
	it("ctx.emit calls host-side emit", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit });

		const result = await sandbox.spawn(
			'export default async (ctx) => { await ctx.emit("order.done", { id: "123" }); }',
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("order.done", { id: "123" });
	});

	it("ctx.event exposes event data", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit, payload: { orderId: "abc" } });

		const result = await sandbox.spawn(
			'export default async (ctx) => { await ctx.emit("check", { got: ctx.event.payload.orderId }); }',
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("check", { got: "abc" });
	});

	it("ctx.env exposes environment variables", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit, env: { API_KEY: "secret123" } });

		const result = await sandbox.spawn(
			'export default async (ctx) => { await ctx.emit("check", { key: ctx.env.API_KEY }); }',
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("check", { key: "secret123" });
	});

	it("ctx.fetch returns Response proxy with status and json()", async () => {
		const mockFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: "hello" }), {
					status: 200,
					statusText: "OK",
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof globalThis.fetch;

		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit, fetch: mockFetch });

		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const res = await ctx.fetch("https://api.example.com/data");
				const body = await res.json();
				await ctx.emit("result", { status: res.status, ok: res.ok, data: body.data });
			}`,
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/data",
			undefined,
		);
		expect(emit).toHaveBeenCalledWith("result", {
			status: 200,
			ok: true,
			data: "hello",
		});
	});

	it("ctx.fetch Response has text() method", async () => {
		const mockFetch = vi.fn(
			async () => new Response("plain text body", { status: 200 }),
		) as unknown as typeof globalThis.fetch;

		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit, fetch: mockFetch });

		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const res = await ctx.fetch("https://example.com");
				const text = await res.text();
				await ctx.emit("result", { text });
			}`,
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { text: "plain text body" });
	});

	it("ctx.fetch Response has headers as Map", async () => {
		const mockFetch = vi.fn(
			async () =>
				new Response("", {
					status: 200,
					headers: { "X-Custom": "test-value", "Content-Type": "text/plain" },
				}),
		) as unknown as typeof globalThis.fetch;

		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit, fetch: mockFetch });

		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const res = await ctx.fetch("https://example.com");
				await ctx.emit("result", {
					ct: res.headers.get("content-type"),
					custom: res.headers.get("x-custom"),
					has: res.headers.has("x-custom"),
				});
			}`,
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", {
			ct: "text/plain",
			custom: "test-value",
			has: true,
		});
	});
});

describe("globals", () => {
	it("btoa/atob work", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit });

		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const encoded = btoa("hello");
				const decoded = atob(encoded);
				await ctx.emit("result", { encoded, decoded });
			}`,
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", {
			encoded: "aGVsbG8=",
			decoded: "hello",
		});
	});

	it("setTimeout fires callback and pumps promises", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit });

		const result = await sandbox.spawn(
			`export default async (ctx) => {
				await new Promise(resolve => setTimeout(resolve, 10));
				await ctx.emit("done", {});
			}`,
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("done", {});
	});

	it("clearTimeout cancels timer", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit });

		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const id = setTimeout(() => { throw new Error("should not fire"); }, 10);
				clearTimeout(id);
				await ctx.emit("done", {});
			}`,
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("done", {});
	});
});

describe("concurrent async", () => {
	it("Promise.all with multiple ctx.fetch works", async () => {
		const mockFetch = vi.fn(
			async (url: string) =>
				new Response(JSON.stringify({ url }), { status: 200 }),
		) as unknown as typeof globalThis.fetch;

		const emit = vi.fn(async () => {
			/* no-op */
		});
		const ctx = makeCtx({ emit, fetch: mockFetch });

		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const [r1, r2] = await Promise.all([
					ctx.fetch("https://api1.example.com"),
					ctx.fetch("https://api2.example.com"),
				]);
				const d1 = await r1.json();
				const d2 = await r2.json();
				await ctx.emit("result", { urls: [d1.url, d2.url] });
			}`,
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenCalledWith("result", {
			urls: ["https://api1.example.com", "https://api2.example.com"],
		});
	});
});
