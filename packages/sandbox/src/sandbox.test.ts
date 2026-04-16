import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { MethodMap, RunResult } from "./index.js";
import { sandbox } from "./index.js";

const COLLIDES_RE = /collides/;
const DISPOSED_RE = /disposed/;

interface GuestCtx {
	event: { name: string; payload: unknown };
	env: Record<string, string>;
}

function makeCtx(overrides: Partial<GuestCtx> = {}): GuestCtx {
	return {
		event: overrides.event ?? { name: "test.event", payload: { key: "value" } },
		env: overrides.env ?? {},
	};
}

interface RunArgs {
	ctx?: GuestCtx;
	emit?: (type: string, payload: unknown) => Promise<void>;
	extraMethods?: MethodMap;
	exportName?: string;
	fetch?: typeof globalThis.fetch;
}

async function runSource(
	source: string,
	args: RunArgs = {},
): Promise<RunResult> {
	const opts: { filename?: string; fetch?: typeof globalThis.fetch } = {
		filename: "test.js",
	};
	if (args.fetch) {
		opts.fetch = args.fetch;
	}
	const sb = await sandbox(source, {}, opts);
	try {
		const extras: MethodMap = { ...(args.extraMethods ?? {}) };
		if (args.emit) {
			extras.emit = async (...a) => {
				await args.emit?.(a[0] as string, a[1]);
			};
		}
		return await sb.run(
			args.exportName ?? "default",
			args.ctx ?? makeCtx(),
			extras,
		);
	} finally {
		sb.dispose();
	}
}

function findLog(result: RunResult, method: string) {
	return result.logs.find((l) => l.method === method);
}

describe("sandbox isolation", () => {
	it("action code cannot access process", async () => {
		const result = await runSource(
			"export default async (ctx) => { process.exit(1); }",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("process");
		}
	});

	it("action code cannot access require", async () => {
		const result = await runSource(
			'export default async (ctx) => { require("fs"); }',
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("require");
		}
	});

	it("action code cannot access global fetch", async () => {
		const result = await runSource(
			'export default async (ctx) => { fetch("http://example.com"); }',
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("fetch");
		}
	});

	it("action code cannot access globalThis.constructor to escape", async () => {
		const result = await runSource(
			"export default async (ctx) => { globalThis.constructor.constructor('return this')().process.exit(1); }",
		);
		expect(result.ok).toBe(false);
	});

	it("internal Bridge methods (storeOpaque, derefOpaque, opaqueRef) are not reachable from guest", async () => {
		const result = await runSource(
			`export default async (ctx) => {
				const hasStore = typeof globalThis.storeOpaque !== 'undefined';
				const hasDeref = typeof globalThis.derefOpaque !== 'undefined';
				const hasRef = typeof globalThis.opaqueRef !== 'undefined';
				return { hasStore, hasDeref, hasRef };
			}`,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toEqual({
				hasStore: false,
				hasDeref: false,
				hasRef: false,
			});
		}
	});
});

describe("sandbox results", () => {
	it("successful execution returns ok: true", async () => {
		const result = await runSource("export default async (ctx) => { }");
		expect(result.ok).toBe(true);
	});

	it("export return value appears as result on success", async () => {
		const result = await runSource(
			"export default async (ctx) => { return { status: 'ok', n: 42 }; }",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toEqual({ status: "ok", n: 42 });
		}
	});

	it("thrown error returns ok: false with message and stack", async () => {
		const result = await runSource(
			'export default async (ctx) => { throw new Error("something broke"); }',
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("something broke");
			expect(result.error.stack).toBeDefined();
		}
	});

	it("rejected promise returns ok: false", async () => {
		const result = await runSource(
			'export default async (ctx) => { return Promise.reject(new Error("rejected")); }',
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("rejected");
		}
	});

	it("missing export returns ok: false", async () => {
		const result = await runSource(
			"export async function present(ctx) { return 1; }",
			{ exportName: "missing" },
		);
		expect(result.ok).toBe(false);
	});
});

describe("ctx bridge", () => {
	it("emit host method is callable as a global", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			'export default async (ctx) => { await emit("order.done", { id: "123" }); }',
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("order.done", { id: "123" });
	});

	it("ctx.event exposes event data", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			'export default async (ctx) => { await emit("check", { got: ctx.event.payload.orderId }); }',
			{
				emit,
				ctx: makeCtx({ event: { name: "test", payload: { orderId: "abc" } } }),
			},
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("check", { got: "abc" });
	});

	it("ctx.env exposes environment variables", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			'export default async (ctx) => { await emit("check", { key: ctx.env.API_KEY }); }',
			{ emit, ctx: makeCtx({ env: { API_KEY: "secret123" } }) },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("check", { key: "secret123" });
	});
});

describe("extraMethods", () => {
	it("extraMethods are callable as globals during run", async () => {
		const result = await runSource(
			`export default async (ctx) => {
				const x = await extra(21);
				return { x };
			}`,
			{
				extraMethods: {
					extra: async (...args) => (args[0] as number) * 2,
				},
			},
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toEqual({ x: 42 });
		}
	});

	it("extraMethods are removed between runs", async () => {
		const sb = await sandbox(
			`export async function withExtra(ctx) {
				return typeof extra;
			}
			export async function withoutExtra(ctx) {
				return typeof extra;
			}`,
			{},
		);
		try {
			const r1 = await sb.run(
				"withExtra",
				{},
				{
					extra: async () => "ok",
				},
			);
			expect(r1.ok).toBe(true);
			if (r1.ok) {
				expect(r1.result).toBe("function");
			}

			const r2 = await sb.run("withoutExtra", {});
			expect(r2.ok).toBe(true);
			if (r2.ok) {
				expect(r2.result).toBe("undefined");
			}
		} finally {
			sb.dispose();
		}
	});

	it("extraMethods shadowing a built-in global throws", async () => {
		const sb = await sandbox("export default async (ctx) => {}", {});
		try {
			await expect(
				sb.run("default", {}, { console: async () => "shadow" }),
			).rejects.toThrow(COLLIDES_RE);
		} finally {
			sb.dispose();
		}
	});

	it("extraMethods shadowing a construction-time method throws", async () => {
		const sb = await sandbox("export default async (ctx) => {}", {
			baseMethod: async () => "base",
		});
		try {
			await expect(
				sb.run("default", {}, { baseMethod: async () => "shadow" }),
			).rejects.toThrow(COLLIDES_RE);
		} finally {
			sb.dispose();
		}
	});
});

describe("vm lifecycle", () => {
	it("module-level state persists across runs within a sandbox", async () => {
		const sb = await sandbox(
			`let count = 0;
			export async function tick(ctx) { return ++count; }`,
			{},
		);
		try {
			const r1 = await sb.run("tick", {});
			const r2 = await sb.run("tick", {});
			const r3 = await sb.run("tick", {});
			expect(r1.ok && r1.result).toBe(1);
			expect(r2.ok && r2.result).toBe(2);
			expect(r3.ok && r3.result).toBe(3);
		} finally {
			sb.dispose();
		}
	});

	it("dispose() releases resources; subsequent run() throws", async () => {
		const sb = await sandbox("export default async (ctx) => {}", {});
		sb.dispose();
		await expect(sb.run("default", {})).rejects.toThrow(DISPOSED_RE);
	});

	it("two independent sandboxes have isolated module-level state", async () => {
		const source = `let count = 0;
			export async function tick(ctx) { return ++count; }`;
		const a = await sandbox(source, {});
		const b = await sandbox(source, {});
		try {
			await a.run("tick", {});
			await a.run("tick", {});
			const ra = await a.run("tick", {});
			const rb = await b.run("tick", {});
			expect(ra.ok && ra.result).toBe(3);
			expect(rb.ok && rb.result).toBe(1);
		} finally {
			a.dispose();
			b.dispose();
		}
	});

	it("opaque-ref ids from one sandbox are not dereferenceable in another", async () => {
		const source = `export async function genKey(ctx) {
			const k = await crypto.subtle.generateKey(
				{ name: "AES-GCM", length: 256 }, false, ["encrypt"]
			);
			return { id: k.__opaqueId, type: k.type };
		}
		export async function useForeignKey(ctx) {
			const fake = Object.freeze({
				__opaqueId: ctx.foreignId,
				type: 'secret',
				algorithm: { name: 'AES-GCM', length: 256 },
				extractable: false,
				usages: ['encrypt'],
			});
			try {
				await crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv: [0,0,0,0,0,0,0,0,0,0,0,0] },
					fake,
					[1,2,3],
				);
				return { ok: true };
			} catch (err) {
				return { ok: false, message: String(err?.message ?? err) };
			}
		}`;
		const a = await sandbox(source, {});
		const b = await sandbox(source, {});
		try {
			const gen = await a.run("genKey", {});
			expect(gen.ok).toBe(true);
			const id = gen.ok ? (gen.result as { id: number; type: string }).id : 0;
			const res = await b.run("useForeignKey", {
				event: { name: "t", payload: {} },
				env: {},
				foreignId: id,
			});
			// Sandbox b's crypto should reject the foreign opaque id because its
			// own opaque store has no entry at that index.
			expect(res.ok).toBe(true);
			if (res.ok) {
				expect((res.result as { ok: boolean; message?: string }).ok).toBe(
					false,
				);
			}
		} finally {
			a.dispose();
			b.dispose();
		}
	});
});

describe("__hostFetch bridge", () => {
	const mockFetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: "hello" }), {
				status: 200,
				statusText: "OK",
				headers: { "Content-Type": "application/json", "X-Custom": "test" },
			}),
	) as unknown as typeof globalThis.fetch;

	it("__hostFetch returns status and body", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const res = await __hostFetch("GET", "https://api.example.com/data", {}, null);
				await emit("result", { status: res.status, statusText: res.statusText, hasBody: typeof res.body === "string" });
			}`,
			{ emit, fetch: mockFetch },
		);
		expect(result.ok).toBe(true);
		expect(mockFetch).toHaveBeenCalled();
		expect(emit).toHaveBeenCalledWith("result", {
			status: 200,
			statusText: "OK",
			hasBody: true,
		});
	});

	it("__hostFetch returns headers as object", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const res = await __hostFetch("GET", "https://api.example.com/data", {}, null);
				await emit("result", { ct: res.headers["content-type"], custom: res.headers["x-custom"] });
			}`,
			{ emit, fetch: mockFetch },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", {
			ct: "application/json",
			custom: "test",
		});
	});

	it("__hostFetch passes method and headers to host fetch", async () => {
		const fetchSpy = vi.fn(
			async () => new Response("{}", { status: 201 }),
		) as unknown as typeof globalThis.fetch;
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const res = await __hostFetch("POST", "https://api.example.com/items", {"authorization": "Bearer tok"}, '{"name":"test"}');
				await emit("result", { status: res.status });
			}`,
			{ emit, fetch: fetchSpy },
		);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/items", {
			method: "POST",
			headers: { authorization: "Bearer tok" },
			body: '{"name":"test"}',
		});
		expect(emit).toHaveBeenCalledWith("result", { status: 201 });
	});
});

describe("globals", () => {
	it("setTimeout fires callback and pumps promises", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				await new Promise(resolve => setTimeout(resolve, 10));
				await emit("done", {});
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("done", {});
	});

	it("clearTimeout cancels timer", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const id = setTimeout(() => { throw new Error("should not fire"); }, 10);
				clearTimeout(id);
				await emit("done", {});
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("done", {});
	});

	it("setTimeout inside __hostFetch .then resolves outer promise", async () => {
		const mockFetch = vi.fn(
			async () => new Response("{}", { status: 200 }),
		) as unknown as typeof globalThis.fetch;
		const emit = vi.fn(async () => {
			/* no-op */
		});

		const result = await Promise.race([
			runSource(
				`export default async (ctx) => {
					const value = await new Promise((resolve) => {
						__hostFetch("GET", "https://api.example.com", {}, null).then(() => {
							setTimeout(() => resolve("done"), 0);
						});
					});
					await emit("r", { value });
				}`,
				{ emit, fetch: mockFetch },
			),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("sandbox hung")), 2000),
			),
		]);

		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("r", { value: "done" });
	});

	// End-to-end regression: spawn the real built workflow bundle and run
	// `fetch(...)` through the full polyfill chain. Requires a prior
	// `pnpm build` to have produced the bundle with the new `emit()` global
	// workflow source; the skipIf guard disables this test when the bundle
	// is absent (e.g. CI jobs that don't build before testing).
	const bundledPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"../../../workflows/dist/cronitor/actions.js",
	);
	it.skipIf(!existsSync(bundledPath))(
		"real bundled workflow with fetch() completes without hanging",
		async () => {
			const source = readFileSync(bundledPath, "utf8");
			const mockFetch = vi.fn(
				async () => new Response('{"ok":1}', { status: 200 }),
			) as unknown as typeof globalThis.fetch;
			const emit = vi.fn(async () => {});
			const ctx: GuestCtx = {
				event: { name: "notify.message", payload: { message: "hello" } },
				env: {
					NEXTCLOUD_URL: "https://example.com",
					NEXTCLOUD_TALK_ROOM: "room1",
					NEXTCLOUD_USERNAME: "u",
					NEXTCLOUD_APP_PASSWORD: "p",
				},
			};

			const result = await Promise.race([
				runSource(source, {
					ctx,
					emit,
					fetch: mockFetch,
					exportName: "sendMessage",
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("bundled action hung")), 5000),
				),
			]);

			expect(result.ok).toBe(true);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		},
	);
});

describe("concurrent async", () => {
	it("Promise.all with multiple __hostFetch works", async () => {
		const mockFetch = vi.fn(
			async () => new Response("{}", { status: 200 }),
		) as unknown as typeof globalThis.fetch;
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const [r1, r2] = await Promise.all([
					__hostFetch("GET", "https://api1.example.com", {}, null),
					__hostFetch("GET", "https://api2.example.com", {}, null),
				]);
				await emit("result", { count: 2, ok: r1.status === 200 && r2.status === 200 });
			}`,
			{ emit, fetch: mockFetch },
		);
		expect(result.ok).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenCalledWith("result", { count: 2, ok: true });
	});
});

describe("logging", () => {
	it("result.logs is an array on success", async () => {
		const result = await runSource("export default async (ctx) => { }");
		expect(result.ok).toBe(true);
		expect(Array.isArray(result.logs)).toBe(true);
	});

	it("result.logs is an array on error", async () => {
		const result = await runSource(
			'export default async (ctx) => { throw new Error("fail"); }',
		);
		expect(result.ok).toBe(false);
		expect(Array.isArray(result.logs)).toBe(true);
	});

	it("console.log produces log entry", async () => {
		const result = await runSource(
			'export default async (ctx) => { console.log("hello"); }',
		);
		expect(result.ok).toBe(true);
		const entry = findLog(result, "console.log");
		expect(entry).toBeDefined();
		expect(entry?.args).toEqual(["hello"]);
		expect(entry?.status).toBe("ok");
	});

	it("console.warn and console.error produce correct method names", async () => {
		const result = await runSource(
			'export default async (ctx) => { console.warn("slow"); console.error("bad"); }',
		);
		expect(result.ok).toBe(true);
		expect(findLog(result, "console.warn")).toBeDefined();
		expect(findLog(result, "console.error")).toBeDefined();
	});

	it("emit produces log entry", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			'export default async (ctx) => { await emit("done", {}); }',
			{ emit },
		);
		expect(result.ok).toBe(true);
		const entry = findLog(result, "emit");
		expect(entry).toBeDefined();
		expect(entry?.status).toBe("ok");
		expect(entry?.args).toEqual(["done", {}]);
	});

	it("__hostFetch produces log entry with method xhr.send", async () => {
		const mockFetch = vi.fn(
			async () => new Response("{}", { status: 200 }),
		) as unknown as typeof globalThis.fetch;
		const result = await runSource(
			`export default async (ctx) => {
				await __hostFetch("GET", "https://api.example.com", {}, null);
			}`,
			{ fetch: mockFetch },
		);
		expect(result.ok).toBe(true);
		const entry = findLog(result, "xhr.send");
		expect(entry).toBeDefined();
		expect(entry?.status).toBe("ok");
		expect(entry?.args?.[0]).toBe("GET");
		expect(entry?.args?.[1]).toBe("https://api.example.com");
	});

	it("bridge log entries have timing fields", async () => {
		const result = await runSource(
			"export default async (ctx) => { crypto.randomUUID(); }",
		);
		expect(result.ok).toBe(true);
		const entry = findLog(result, "randomUUID");
		expect(entry).toBeDefined();
		expect(typeof entry?.ts).toBe("number");
		expect(typeof entry?.durationMs).toBe("number");
	});

	it("per-run log buffer is reset between runs on the same sandbox", async () => {
		const sb = await sandbox(
			`export async function first(ctx) { console.log("first"); }
			export async function second(ctx) { console.log("second"); }`,
			{},
		);
		try {
			const r1 = await sb.run("first", {});
			expect(r1.ok).toBe(true);
			expect(r1.logs.some((l) => l.args?.[0] === "first")).toBe(true);

			const r2 = await sb.run("second", {});
			expect(r2.ok).toBe(true);
			expect(r2.logs.some((l) => l.args?.[0] === "first")).toBe(false);
			expect(r2.logs.some((l) => l.args?.[0] === "second")).toBe(true);
		} finally {
			sb.dispose();
		}
	});
});

describe("crypto", () => {
	it("crypto.randomUUID returns valid UUID format", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const uuid = crypto.randomUUID();
				const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
				await emit("result", { valid });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { valid: true });
	});

	it("crypto.getRandomValues returns filled array of correct length", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const arr = crypto.getRandomValues(new Array(16).fill(0));
				await emit("result", { len: arr.length, allZero: arr.every(v => v === 0) });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { len: 16, allZero: false });
	});

	it("crypto.subtle.digest computes correct SHA-256 hash", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const data = [104, 101, 108, 108, 111];
				const hash = await crypto.subtle.digest("SHA-256", data);
				await emit("result", { len: hash.length, first: hash[0], second: hash[1] });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", {
			len: 32,
			first: 0x2c,
			second: 0xf2,
		});
	});

	it("crypto.subtle.importKey + sign + verify round-trip (HMAC)", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const keyBytes = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
				const key = await crypto.subtle.importKey(
					"raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
				);
				const data = [104, 101, 108, 108, 111];
				const sig = await crypto.subtle.sign("HMAC", key, data);
				const valid = await crypto.subtle.verify("HMAC", key, sig, data);
				await emit("result", { valid, sigLen: sig.length });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { valid: true, sigLen: 32 });
	});

	it("crypto.subtle.verify returns false for tampered data", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const keyBytes = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
				const key = await crypto.subtle.importKey(
					"raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
				);
				const data = [104, 101, 108, 108, 111];
				const sig = await crypto.subtle.sign("HMAC", key, data);
				const wrong = [0, 0, 0, 0, 0];
				const valid = await crypto.subtle.verify("HMAC", key, sig, wrong);
				await emit("result", { valid });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { valid: false });
	});

	it("crypto.subtle.generateKey returns single key (AES-GCM)", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const key = await crypto.subtle.generateKey(
					{ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
				);
				await emit("result", {
					type: key.type,
					hasId: typeof key.__opaqueId === "number",
					algo: key.algorithm.name,
				});
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", {
			type: "secret",
			hasId: true,
			algo: "AES-GCM",
		});
	});

	it("crypto.subtle.generateKey returns key pair (ECDSA)", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const pair = await crypto.subtle.generateKey(
					{ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]
				);
				await emit("result", {
					pubType: pair.publicKey.type,
					privType: pair.privateKey.type,
					pubHasId: typeof pair.publicKey.__opaqueId === "number",
					privHasId: typeof pair.privateKey.__opaqueId === "number",
				});
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", {
			pubType: "public",
			privType: "private",
			pubHasId: true,
			privHasId: true,
		});
	});

	it("crypto.subtle.encrypt + decrypt AES-GCM round-trip", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const key = await crypto.subtle.generateKey(
					{ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
				);
				const iv = crypto.getRandomValues(new Array(12).fill(0));
				const plaintext = [72, 101, 108, 108, 111];
				const ciphertext = await crypto.subtle.encrypt(
					{ name: "AES-GCM", iv }, key, plaintext
				);
				const decrypted = await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv }, key, ciphertext
				);
				await emit("result", { match: JSON.stringify(decrypted) === JSON.stringify(plaintext) });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { match: true });
	});

	it("crypto.subtle.exportKey matches original imported bytes", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const keyBytes = Array.from({ length: 32 }, (_, i) => i);
		const result = await runSource(
			`export default async (ctx) => {
				const keyBytes = ${JSON.stringify(keyBytes)};
				const key = await crypto.subtle.importKey(
					"raw", keyBytes, { name: "AES-GCM", length: 256 }, true, ["encrypt"]
				);
				const exported = await crypto.subtle.exportKey("raw", key);
				await emit("result", { match: JSON.stringify(exported) === JSON.stringify(keyBytes) });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { match: true });
	});

	it("CryptoKey handle is frozen object with metadata", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const key = await crypto.subtle.importKey(
					"raw",
					[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
					{ name: "HMAC", hash: "SHA-256" },
					true,
					["sign", "verify"]
				);
				const frozen = Object.isFrozen(key);
				const keys = Object.keys(key).sort();
				let threw = false;
				try { key.__opaqueId = 999; } catch { threw = true; }
				await emit("result", { frozen, keys, threw, type: key.type });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", {
			frozen: true,
			keys: ["__opaqueId", "algorithm", "extractable", "type", "usages"],
			threw: true,
			type: "secret",
		});
	});

	it("invalid opaque reference produces failed log entry", async () => {
		const result = await runSource(
			`export default async (ctx) => {
				await crypto.subtle.sign("HMAC", { __opaqueId: 999 }, [1, 2, 3]);
			}`,
		);
		expect(result.ok).toBe(false);
		const entry = findLog(result, "crypto.subtle.sign");
		expect(entry).toBeDefined();
		expect(entry?.status).toBe("failed");
		expect(entry?.error).toContain("999");
	});

	it("exportKey on non-extractable key rejects", async () => {
		const result = await runSource(
			`export default async (ctx) => {
				const key = await crypto.subtle.generateKey(
					{ name: "AES-GCM", length: 256 }, false, ["encrypt"]
				);
				try {
					await crypto.subtle.exportKey("raw", key);
					return { ok: true };
				} catch (err) {
					return { ok: false, message: String(err?.message ?? err) };
				}
			}`,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect((result.result as { ok: boolean }).ok).toBe(false);
		}
	});
});

describe("performance", () => {
	it("performance.now returns number >= 0", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const t = performance.now();
				await emit("result", { isNumber: typeof t === "number", nonNeg: t >= 0 });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", {
			isNumber: true,
			nonNeg: true,
		});
	});

	it("performance.now increases over time", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				const t1 = performance.now();
				await new Promise(resolve => setTimeout(resolve, 50));
				const t2 = performance.now();
				await emit("result", { increased: t2 > t1 });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { increased: true });
	});
});

describe("polyfill scope detection", () => {
	// Side-effect polyfills pick their install target via UMD-style scope
	// detection. QuickJS module top-level has no window/global/this, so
	// `@workflow-engine/sandbox-globals-setup` aliases `self` and `global` to
	// globalThis. This verifies every bundled polyfill's detection lands on
	// globalThis.
	const setupPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"../../sdk/src/plugin/sandbox-globals-setup.js",
	);
	const setup = readFileSync(setupPath, "utf8");

	it("url-polyfill (global→window→self→this) resolves to globalThis", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`${setup}
			(function(scope) { scope.__urlPolyfill = scope; })(
				(typeof global !== 'undefined') ? global
					: ((typeof window !== 'undefined') ? window
					: ((typeof self !== 'undefined') ? self : this))
			);
			export default async (ctx) => {
				await emit("result", { installed: globalThis.__urlPolyfill === globalThis });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { installed: true });
	});

	it("abort-controller/polyfill (self→window→global) resolves to globalThis", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`${setup}
			const g =
				typeof self !== "undefined" ? self :
				typeof window !== "undefined" ? window :
				typeof global !== "undefined" ? global :
				undefined;
			if (g) g.__abortPolyfill = g;
			export default async (ctx) => {
				await emit("result", { installed: globalThis.__abortPolyfill === globalThis });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { installed: true });
	});

	it("blob-polyfill (self→window→global→this) resolves to globalThis", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`${setup}
			(function(scope) { scope.__blobPolyfill = scope; })(
				typeof self !== "undefined" && self ||
					typeof window !== "undefined" && window ||
					typeof global !== "undefined" && global ||
					this
			);
			export default async (ctx) => {
				await emit("result", { installed: globalThis.__blobPolyfill === globalThis });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { installed: true });
	});

	it("fast-text-encoding (window→global→this) resolves to globalThis", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`${setup}
			(function(scope) { scope.__textEncodingPolyfill = scope; })(
				typeof window !== 'undefined' ? window
					: (typeof global !== 'undefined' ? global : this)
			);
			export default async (ctx) => {
				await emit("result", { installed: globalThis.__textEncodingPolyfill === globalThis });
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { installed: true });
	});
});

describe("cancel-on-run-end", () => {
	it("un-awaited setTimeout does not emit after run completes", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await runSource(
			`export default async (ctx) => {
				setTimeout(() => { emit("late", {}); }, 30);
			}`,
			{ emit },
		);
		expect(result.ok).toBe(true);
		await new Promise((r) => setTimeout(r, 100));
		expect(emit).not.toHaveBeenCalled();
	});

	// In-flight fetch abort on run end is worker-native (the AbortController
	// lives in the worker and wraps worker.globalThis.fetch). When
	// options.fetch forwards to main, cancellation is not propagated across
	// the worker↔main boundary — that's a known limitation of the simple
	// forwarding mechanism. The timer-cancel test above covers the main
	// semantic (un-awaited background work does not leak past run end).
});
