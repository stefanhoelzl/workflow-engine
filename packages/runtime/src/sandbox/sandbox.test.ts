import { beforeAll, describe, expect, it, vi } from "vitest";
import { ActionContext } from "../context/index.js";
import type { Sandbox, SandboxResult } from "./index.js";
import { createSandbox } from "./index.js";

function makeCtx(
	overrides: {
		emit?: ActionContext["emit"];
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
		overrides.env ?? {},
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
		expect(result.ok).toBe(true);
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
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const res = await __hostFetch("GET", "https://api.example.com/data", {}, null);
				await ctx.emit("result", { status: res.status, statusText: res.statusText, hasBody: typeof res.body === "string" });
			}`,
			makeCtx({ emit }),
			{ fetch: mockFetch },
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
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const res = await __hostFetch("GET", "https://api.example.com/data", {}, null);
				await ctx.emit("result", { ct: res.headers["content-type"], custom: res.headers["x-custom"] });
			}`,
			makeCtx({ emit }),
			{ fetch: mockFetch },
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
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const res = await __hostFetch("POST", "https://api.example.com/items", {"authorization": "Bearer tok"}, '{"name":"test"}');
				await ctx.emit("result", { status: res.status });
			}`,
			makeCtx({ emit }),
			{ fetch: fetchSpy },
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
	it("Promise.all with multiple __hostFetch works", async () => {
		const mockFetch = vi.fn(
			async () => new Response("{}", { status: 200 }),
		) as unknown as typeof globalThis.fetch;
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const [r1, r2] = await Promise.all([
					__hostFetch("GET", "https://api1.example.com", {}, null),
					__hostFetch("GET", "https://api2.example.com", {}, null),
				]);
				await ctx.emit("result", { count: 2, ok: r1.status === 200 && r2.status === 200 });
			}`,
			makeCtx({ emit }),
			{ fetch: mockFetch },
		);

		expect(result.ok).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenCalledWith("result", { count: 2, ok: true });
	});
});

function findLog(result: SandboxResult, method: string) {
	return result.logs.find((l) => l.method === method);
}

describe("logging", () => {
	it("result.logs is an array on success", async () => {
		const result = await sandbox.spawn(
			"export default async (ctx) => { }",
			makeCtx(),
		);
		expect(result.ok).toBe(true);
		expect(Array.isArray(result.logs)).toBe(true);
	});

	it("result.logs is an array on error", async () => {
		const result = await sandbox.spawn(
			'export default async (ctx) => { throw new Error("fail"); }',
			makeCtx(),
		);
		expect(result.ok).toBe(false);
		expect(Array.isArray(result.logs)).toBe(true);
	});

	it("console.log produces log entry", async () => {
		const result = await sandbox.spawn(
			'export default async (ctx) => { console.log("hello"); }',
			makeCtx(),
		);
		expect(result.ok).toBe(true);
		const entry = findLog(result, "console.log");
		expect(entry).toBeDefined();
		expect(entry?.args).toEqual(["hello"]);
		expect(entry?.status).toBe("ok");
	});

	it("console.warn and console.error produce correct method names", async () => {
		const result = await sandbox.spawn(
			'export default async (ctx) => { console.warn("slow"); console.error("bad"); }',
			makeCtx(),
		);
		expect(result.ok).toBe(true);
		expect(findLog(result, "console.warn")).toBeDefined();
		expect(findLog(result, "console.error")).toBeDefined();
	});

	it("ctx.emit produces log entry", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
			'export default async (ctx) => { await ctx.emit("done", {}); }',
			makeCtx({ emit }),
		);
		expect(result.ok).toBe(true);
		const entry = findLog(result, "ctx.emit");
		expect(entry).toBeDefined();
		expect(entry?.status).toBe("ok");
		expect(entry?.args).toEqual(["done", {}]);
	});

	it("__hostFetch produces log entry with method xhr.send", async () => {
		const mockFetch = vi.fn(
			async () => new Response("{}", { status: 200 }),
		) as unknown as typeof globalThis.fetch;
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				await __hostFetch("GET", "https://api.example.com", {}, null);
			}`,
			makeCtx(),
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
		const result = await sandbox.spawn(
			"export default async (ctx) => { crypto.randomUUID(); }",
			makeCtx(),
		);
		expect(result.ok).toBe(true);
		const entry = findLog(result, "randomUUID");
		expect(entry).toBeDefined();
		expect(typeof entry?.ts).toBe("number");
		expect(typeof entry?.durationMs).toBe("number");
	});
});

describe("crypto", () => {
	it("crypto.randomUUID returns valid UUID format", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const uuid = crypto.randomUUID();
				const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
				await ctx.emit("result", { valid });
			}`,
			makeCtx({ emit }),
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { valid: true });
	});

	it("crypto.getRandomValues returns filled array of correct length", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const arr = crypto.getRandomValues(new Array(16).fill(0));
				await ctx.emit("result", { len: arr.length, allZero: arr.every(v => v === 0) });
			}`,
			makeCtx({ emit }),
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { len: 16, allZero: false });
	});

	it("crypto.subtle.digest computes correct SHA-256 hash", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const data = [104, 101, 108, 108, 111];
				const hash = await crypto.subtle.digest("SHA-256", data);
				await ctx.emit("result", { len: hash.length, first: hash[0], second: hash[1] });
			}`,
			makeCtx({ emit }),
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
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const keyBytes = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
				const key = await crypto.subtle.importKey(
					"raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
				);
				const data = [104, 101, 108, 108, 111];
				const sig = await crypto.subtle.sign("HMAC", key, data);
				const valid = await crypto.subtle.verify("HMAC", key, sig, data);
				await ctx.emit("result", { valid, sigLen: sig.length });
			}`,
			makeCtx({ emit }),
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { valid: true, sigLen: 32 });
	});

	it("crypto.subtle.verify returns false for tampered data", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const keyBytes = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
				const key = await crypto.subtle.importKey(
					"raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
				);
				const data = [104, 101, 108, 108, 111];
				const sig = await crypto.subtle.sign("HMAC", key, data);
				const wrong = [0, 0, 0, 0, 0];
				const valid = await crypto.subtle.verify("HMAC", key, sig, wrong);
				await ctx.emit("result", { valid });
			}`,
			makeCtx({ emit }),
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { valid: false });
	});

	it("crypto.subtle.generateKey returns single key (AES-GCM)", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const key = await crypto.subtle.generateKey(
					{ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
				);
				await ctx.emit("result", {
					type: key.type,
					hasId: typeof key.__opaqueId === "number",
					algo: key.algorithm.name,
				});
			}`,
			makeCtx({ emit }),
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
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const pair = await crypto.subtle.generateKey(
					{ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]
				);
				await ctx.emit("result", {
					pubType: pair.publicKey.type,
					privType: pair.privateKey.type,
					pubHasId: typeof pair.publicKey.__opaqueId === "number",
					privHasId: typeof pair.privateKey.__opaqueId === "number",
				});
			}`,
			makeCtx({ emit }),
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
		const result = await sandbox.spawn(
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
				await ctx.emit("result", { match: JSON.stringify(decrypted) === JSON.stringify(plaintext) });
			}`,
			makeCtx({ emit }),
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { match: true });
	});

	it("crypto.subtle.exportKey matches original imported bytes", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const keyBytes = Array.from({ length: 32 }, (_, i) => i);
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const keyBytes = ${JSON.stringify(keyBytes)};
				const key = await crypto.subtle.importKey(
					"raw", keyBytes, { name: "AES-GCM", length: 256 }, true, ["encrypt"]
				);
				const exported = await crypto.subtle.exportKey("raw", key);
				await ctx.emit("result", { match: JSON.stringify(exported) === JSON.stringify(keyBytes) });
			}`,
			makeCtx({ emit }),
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { match: true });
	});

	it("CryptoKey handle is frozen object with metadata", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
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
				await ctx.emit("result", { frozen, keys, threw, type: key.type });
			}`,
			makeCtx({ emit }),
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
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				await crypto.subtle.sign("HMAC", { __opaqueId: 999 }, [1, 2, 3]);
			}`,
			makeCtx(),
		);
		expect(result.ok).toBe(false);
		const entry = findLog(result, "crypto.subtle.sign");
		expect(entry).toBeDefined();
		expect(entry?.status).toBe("failed");
		expect(entry?.error).toContain("999");
	});
});

describe("performance", () => {
	it("performance.now returns number >= 0", async () => {
		const emit = vi.fn(async () => {
			/* no-op */
		});
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const t = performance.now();
				await ctx.emit("result", { isNumber: typeof t === "number", nonNeg: t >= 0 });
			}`,
			makeCtx({ emit }),
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
		const result = await sandbox.spawn(
			`export default async (ctx) => {
				const t1 = performance.now();
				await new Promise(resolve => setTimeout(resolve, 50));
				const t2 = performance.now();
				await ctx.emit("result", { increased: t2 > t1 });
			}`,
			makeCtx({ emit }),
		);
		expect(result.ok).toBe(true);
		expect(emit).toHaveBeenCalledWith("result", { increased: true });
	});
});
