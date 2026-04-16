import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import { type RunResult, sandbox } from "./index.js";

const ONLY_ACTION_RE = /only action.\* allowed/;
const JSON_PARSE_ERROR_RE = /JSON|Unexpected|parse/i;

const RUN_OPTS = {
	invocationId: "evt_test",
	workflow: "wf",
	workflowSha: "sha-abc",
};

// Wrap a body of `exports.X = ...; exports.Y = ...;` statements in an IIFE
// that assigns to `globalThis.__workflowExports` — the default namespace the
// sandbox reads exports from.
function iife(body: string): string {
	return `var __workflowExports = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

// Convenience: a single default export shaped like `async (ctx) => <body>`.
function defaultHandler(handlerBody: string): string {
	return iife(`exports.default = async function(ctx) { ${handlerBody} };`);
}

async function runSource(
	source: string,
	options: {
		exportName?: string;
		ctx?: unknown;
		methods?: Record<string, (...args: unknown[]) => Promise<unknown>>;
		methodEventNames?: Record<string, string>;
		fetch?: typeof globalThis.fetch;
	} = {},
): Promise<{ result: RunResult; events: InvocationEvent[] }> {
	const sbOptions: {
		methodEventNames?: Record<string, string>;
		fetch?: typeof globalThis.fetch;
	} = {};
	if (options.methodEventNames) {
		sbOptions.methodEventNames = options.methodEventNames;
	}
	if (options.fetch) {
		sbOptions.fetch = options.fetch;
	}
	const sb = await sandbox(source, options.methods ?? {}, sbOptions);
	const events: InvocationEvent[] = [];
	sb.onEvent((e) => events.push(e));
	try {
		const result = await sb.run(
			options.exportName ?? "default",
			options.ctx ?? {},
			RUN_OPTS,
		);
		return { result, events };
	} finally {
		sb.dispose();
	}
}

describe("sandbox isolation", () => {
	it("guest cannot access process", async () => {
		const { result } = await runSource(defaultHandler("process.exit(1);"));
		expect(result.ok).toBe(false);
	});

	it("RunResult has no logs field", async () => {
		const { result } = await runSource(defaultHandler("return 42;"));
		expect(result.ok).toBe(true);
		expect((result as { logs?: unknown }).logs).toBeUndefined();
	});

	it("invokes named exports with the ctx argument", async () => {
		const { result } = await runSource(
			iife("exports.handler = async (ctx) => ctx.x * 2;"),
			{ exportName: "handler", ctx: { x: 21 } },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe(42);
		}
	});

	it("returns ok=false with serialized error for missing export", async () => {
		const { result } = await runSource(iife("exports.a = 1;"), {
			exportName: "missing",
		});
		expect(result.ok).toBe(false);
	});

	it("fetch is available as a shim routing through __hostFetch", async () => {
		const { result } = await runSource(defaultHandler("return typeof fetch;"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe("function");
		}
	});

	it("WASM extensions expose standard globals", async () => {
		const { result } = await runSource(
			defaultHandler(
				`return {
					url: typeof URL,
					headers: typeof Headers,
					enc: typeof TextEncoder,
					dec: typeof TextDecoder,
					atob: typeof atob,
					btoa: typeof btoa,
					clone: typeof structuredClone,
					crypto: typeof crypto,
				};`,
			),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toEqual({
				url: "function",
				headers: "function",
				enc: "function",
				dec: "function",
				atob: "function",
				btoa: "function",
				clone: "function",
				crypto: "object",
			});
		}
	});

	it("crypto.subtle methods return Promises (shim applied)", async () => {
		const { result } = await runSource(
			defaultHandler(
				`const data = new TextEncoder().encode("hello");
				const p = crypto.subtle.digest("SHA-256", data);
				return typeof p.then;`,
			),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe("function");
		}
	});
});

describe("fetch shim", () => {
	function mockFetch(res: {
		status?: number;
		body?: string;
		headers?: Record<string, string>;
	}): typeof globalThis.fetch {
		return (async () => {
			const init: ResponseInit = {
				status: res.status ?? 200,
				...(res.headers ? { headers: res.headers } : {}),
			};
			return new Response(res.body ?? "", init);
		}) as typeof globalThis.fetch;
	}

	it("response.ok reflects the 2xx range", async () => {
		// Node's Response constructor rejects status < 200, so the lower
		// boundary isn't directly testable. The fetch shim reads `status`
		// from the __hostFetch response verbatim and computes
		// `ok = 200 <= status < 300` — the critical boundaries are 200
		// (inclusive), 299 (inclusive), 300 (exclusive), and common
		// non-2xx codes like 404/500.
		const cases: ReadonlyArray<readonly [number, boolean]> = [
			[200, true],
			[250, true],
			[299, true],
			[300, false],
			[404, false],
			[500, false],
		];
		const runs = await Promise.all(
			cases.map(([status]) =>
				runSource(
					defaultHandler(
						`const r = await fetch("https://x"); return { status: r.status, ok: r.ok };`,
					),
					{ fetch: mockFetch({ status, body: "" }) },
				),
			),
		);
		for (let i = 0; i < cases.length; i++) {
			const [status, ok] = cases[i] as readonly [number, boolean];
			const { result } = runs[i] as (typeof runs)[number];
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toEqual({ status, ok });
			}
		}
	});

	it("response.json() rejects (not throws) on invalid JSON", async () => {
		const { result } = await runSource(
			defaultHandler(
				`const r = await fetch("https://x");
				try {
					await r.json();
					return { threw: false };
				} catch (e) {
					return { threw: true, message: String(e.message || e) };
				}`,
			),
			{ fetch: mockFetch({ body: "not json {{{" }) },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const r = result.result as { threw: boolean; message: string };
			expect(r.threw).toBe(true);
			expect(r.message).toMatch(JSON_PARSE_ERROR_RE);
		}
	});

	it("response.json() rejection is catchable with .catch()", async () => {
		// Proves json() returns a true Promise (not a synchronous throw that
		// happens to be caught by the outer await).
		const { result } = await runSource(
			defaultHandler(
				`const r = await fetch("https://x");
				return r.json().catch(() => "caught");`,
			),
			{ fetch: mockFetch({ body: "not json" }) },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe("caught");
		}
	});

	it("globalThis.fetch is non-writable (reassignment is a no-op)", async () => {
		const { result } = await runSource(
			defaultHandler(`
				const before = fetch;
				try {
					globalThis.fetch = function() { return Promise.resolve("hacked"); };
				} catch (_e) {
					// strict mode would throw; non-strict silently ignores.
				}
				return { same: globalThis.fetch === before };
			`),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toEqual({ same: true });
		}
	});

	it("init.signal passed as a plain object is silently ignored", async () => {
		// No WASM extension provides AbortController, so workflow code cannot
		// construct a real AbortSignal. A caller could still pass a plain
		// object with a `signal` field; the shim must neither crash nor
		// short-circuit the fetch. Per-run cancellation happens at the bridge
		// level via AbortController on the main thread — not via init.signal.
		let fetchCalls = 0;
		const liveFetch: typeof globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response("ok", { status: 200 });
		}) as typeof globalThis.fetch;
		const { result } = await runSource(
			defaultHandler(`
				const fakeSignal = { aborted: true };
				const r = await fetch("https://x", { signal: fakeSignal });
				return { status: r.status };
			`),
			{ fetch: liveFetch },
		);
		if (!result.ok) {
			throw new Error(`guest error: ${result.error.message}`);
		}
		expect(result.result).toEqual({ status: 200 });
		expect(fetchCalls).toBe(1);
	});
});

describe("sandbox event streaming", () => {
	it("emits trigger.request first and trigger.response last on success", async () => {
		const { events } = await runSource(
			defaultHandler("return { status: 200, body: 'ok' };"),
		);
		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events[0]?.kind).toBe("trigger.request");
		expect(events.at(-1)?.kind).toBe("trigger.response");
	});

	it("emits trigger.error as the last event on handler throw", async () => {
		const { events } = await runSource(
			defaultHandler("throw new Error('boom');"),
		);
		expect(events.at(-1)?.kind).toBe("trigger.error");
		const err = events.at(-1) as InvocationEvent;
		expect(err.error?.message).toContain("boom");
	});

	it("stamps every event with id, workflow, workflowSha", async () => {
		const { events } = await runSource(defaultHandler("return 1;"));
		for (const e of events) {
			expect(e.id).toBe("evt_test");
			expect(e.workflow).toBe("wf");
			expect(e.workflowSha).toBe("sha-abc");
		}
	});

	it("assigns monotonic seq starting at 0", async () => {
		const { events } = await runSource(defaultHandler("return 1;"));
		const seqs = events.map((e) => e.seq);
		const sorted = [...seqs].sort((a, b) => a - b);
		expect(seqs).toEqual(sorted);
		expect(seqs[0]).toBe(0);
	});

	it("trigger.request has ref=null; matching trigger.response has ref=0", async () => {
		const { events } = await runSource(defaultHandler("return 1;"));
		const req = events.find((e) => e.kind === "trigger.request");
		const resp = events.find((e) => e.kind === "trigger.response");
		expect(req?.ref).toBeNull();
		expect(resp?.ref).toBe(req?.seq);
	});

	it("emits paired system.request/system.response for console.log", async () => {
		const { events } = await runSource(
			defaultHandler("console.log('hi', 42); return 1;"),
		);
		const sysReqs = events.filter(
			(e) => e.kind === "system.request" && e.name === "console.log",
		);
		const sysResps = events.filter(
			(e) => e.kind === "system.response" && e.name === "console.log",
		);
		expect(sysReqs).toHaveLength(1);
		expect(sysResps).toHaveLength(1);
		expect(sysResps[0]?.ref).toBe(sysReqs[0]?.seq);
		expect(sysReqs[0]?.input).toEqual(["hi", 42]);
	});

	it("uses methodEventNames override for the system event name", async () => {
		const { events } = await runSource(
			defaultHandler("await myMethod('arg');"),
			{
				methods: { myMethod: async () => undefined },
				methodEventNames: { myMethod: "host.custom" },
			},
		);
		const sysReq = events.find(
			(e) => e.kind === "system.request" && e.name === "host.custom",
		);
		expect(sysReq).toBeDefined();
	});

	it("__emitEvent is callable from guest and stamps action.* events", async () => {
		const { events } = await runSource(
			defaultHandler(
				`__emitEvent({ kind: "action.request", name: "notify", input: { ch: "ops" } });
				__emitEvent({ kind: "action.response", name: "notify", output: { sent: true } });
				return 1;`,
			),
		);
		const actionReqs = events.filter((e) => e.kind === "action.request");
		const actionResps = events.filter((e) => e.kind === "action.response");
		expect(actionReqs).toHaveLength(1);
		expect(actionResps).toHaveLength(1);
		expect(actionReqs[0]?.name).toBe("notify");
		expect(actionResps[0]?.ref).toBe(actionReqs[0]?.seq);
	});

	it("__emitEvent does NOT itself appear as a system.request", async () => {
		const { events } = await runSource(
			defaultHandler(
				`__emitEvent({ kind: "action.request", name: "n" });
				__emitEvent({ kind: "action.response", name: "n" });
				return 1;`,
			),
		);
		const emitSysEvents = events.filter(
			(e) =>
				(e.kind === "system.request" || e.kind === "system.response") &&
				e.name === "__emitEvent",
		);
		expect(emitSysEvents).toHaveLength(0);
	});

	it("__emitEvent rejects non-action kinds", async () => {
		const { events } = await runSource(
			defaultHandler(
				`try { __emitEvent({ kind: "system.request", name: "x" }); return "no-throw"; }
				catch (e) { return e.message; }`,
			),
		);
		const trigResp = events.find((e) => e.kind === "trigger.response");
		expect(String(trigResp?.output)).toMatch(ONLY_ACTION_RE);
	});

	it("nested action and system events have correct refs forming a tree", async () => {
		const { events } = await runSource(
			defaultHandler(
				`__emitEvent({ kind: "action.request", name: "outer", input: 1 });
				console.log("inside outer");
				__emitEvent({ kind: "action.response", name: "outer", output: 2 });
				return 0;`,
			),
		);
		// trigger.request seq=0 (ref null)
		// action.request "outer" seq=1 (ref 0)
		// system.request console.log seq=2 (ref 1)
		// system.response console.log seq=3 (ref 2)
		// action.response "outer" seq=4 (ref 1)
		// trigger.response seq=5 (ref 0)
		const byKindName = (k: string, n?: string) =>
			events.find((e) => e.kind === k && (!n || e.name === n));
		expect(byKindName("trigger.request")?.ref).toBeNull();
		expect(byKindName("action.request", "outer")?.ref).toBe(0);
		expect(byKindName("system.request", "console.log")?.ref).toBe(1);
		expect(byKindName("system.response", "console.log")?.ref).toBe(2);
		expect(byKindName("action.response", "outer")?.ref).toBe(1);
		expect(byKindName("trigger.response")?.ref).toBe(0);
	});
});

describe("sandbox dispose", () => {
	it("rejects subsequent run calls after dispose", async () => {
		const sb = await sandbox(defaultHandler("return 1;"), {});
		sb.dispose();
		await expect(sb.run("default", null, RUN_OPTS)).rejects.toThrow();
	});
});

describe("sandbox memory limit", () => {
	it("rejects allocation-heavy code when memoryLimit is set", async () => {
		// 1 MB limit — allocating a huge typed array should fail.
		const sb = await sandbox(
			defaultHandler(
				`try {
					const arr = new Uint8Array(8 * 1024 * 1024);
					return { ok: true, len: arr.length };
				} catch (e) {
					return { ok: false, err: String(e && e.message) };
				}`,
			),
			{},
			{ memoryLimit: 1024 * 1024 },
		);
		try {
			const result = await sb.run("default", null, RUN_OPTS);
			// The guest either returns { ok: false } from its catch, or the
			// whole run fails with an OOM — both are acceptable evidence that
			// the limit is enforced.
			if (result.ok) {
				const inner = result.result as { ok?: boolean };
				expect(inner.ok).toBe(false);
			} else {
				expect(result.ok).toBe(false);
			}
		} finally {
			sb.dispose();
		}
	});
});
