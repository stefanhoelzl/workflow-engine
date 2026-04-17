import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import { type RunResult, sandbox } from "./index.js";

function readPackageVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		const candidate = resolve(dir, "package.json");
		if (existsSync(candidate)) {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
				name?: string;
				version?: string;
			};
			if (parsed.name === "@workflow-engine/sandbox" && parsed.version) {
				return parsed.version;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	throw new Error("sandbox test: could not locate package.json");
}

const PACKAGE_VERSION = readPackageVersion();

const ONLY_ACTION_RE = /only action.\* allowed/;
const JSON_PARSE_ERROR_RE = /JSON|Unexpected|parse/i;
const SHA256_FIRST_16_RE = /^[0-9a-f]{32}$/;

const RUN_OPTS = {
	invocationId: "evt_test",
	workflow: "wf",
	workflowSha: "sha-abc",
};

// Wrap a body of `exports.X = ...; exports.Y = ...;` statements in an IIFE
// that assigns to `globalThis.__wfe_exports__` — the fixed namespace the
// sandbox reads exports from (see IIFE_NAMESPACE in @workflow-engine/core).
function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
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

	// The missing-export error must identify the requested export but must NOT
	// leak the IIFE namespace identifier across the sandbox boundary — operators
	// recover workflow identity via log prefix / stack-frame filename instead
	// (see openspec/changes/simplify-iife-namespace/specs/sandbox/spec.md).
	it("missing-export error names the export but does not leak the namespace identifier", async () => {
		const { result } = await runSource(iife("exports.a = 1;"), {
			exportName: "missing",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("missing");
			expect(result.error.message).not.toContain("__wfe_exports__");
			expect(result.error.message).not.toContain("__wf_");
			expect(result.error.message).not.toContain("__workflowExports");
		}
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

	it("every event carries a valid ISO at and non-negative integer ts (µs)", async () => {
		const { events } = await runSource(defaultHandler("return 1;"));
		expect(events.length).toBeGreaterThan(0);
		for (const e of events) {
			expect(typeof e.at).toBe("string");
			expect(Number.isNaN(Date.parse(e.at))).toBe(false);
			expect(Number.isInteger(e.ts)).toBe(true);
			expect(e.ts).toBeGreaterThanOrEqual(0);
		}
	});

	it("trigger.request ts is near zero; terminal ts exceeds it on a non-trivial run", async () => {
		const { events } = await runSource(
			defaultHandler(
				"let acc = 0; for (let i = 0; i < 50000; i++) acc += i; return acc;",
			),
		);
		const req = events.find((e) => e.kind === "trigger.request");
		const term = events.at(-1);
		expect(req?.ts).toBeLessThan(100_000); // < 100ms in µs
		expect(term?.ts ?? 0).toBeGreaterThan(req?.ts ?? 0);
	});

	it("guest performance.now() and bridge-sourced event ts are both run-anchored", async () => {
		const { result, events } = await runSource(
			defaultHandler(`
				const g = performance.now();
				return { g };
			`),
		);
		if (!result.ok) {
			throw new Error(`guest error: ${result.error.message}`);
		}
		const { g } = result.result as { g: number };
		const term = events.at(-1);
		const termTs = term?.ts ?? 0;
		// Both readings are run-anchored: guest's `performance.now()` is
		// anchored at VM init (QuickJS caches the monotonic reference on
		// first read), while the terminal event's `ts` is anchored at
		// the most recent handleRun reset. The small delta between the
		// two anchors is the VM-init-to-run-start gap. Both stay small
		// (absolute value under 1 s for any realistic sandbox run) and
		// the terminal event is strictly after the guest's read.
		expect(Math.abs(g)).toBeLessThan(1000); // < 1 s
		expect(termTs).toBeGreaterThanOrEqual(0);
		expect(termTs).toBeLessThan(1_000_000); // < 1 s in µs
	});

	it("guest cannot override at or ts on events emitted via __emitEvent", async () => {
		// __emitEvent is the internal emission hook. Even if guest tampers with
		// the event payload, the host-side `installEmitEvent` closure stamps
		// `at` and `ts` itself and discards any guest-supplied values on the
		// outer object. Here we call __emitEvent directly to verify this.
		const { events } = await runSource(
			defaultHandler(`
				globalThis.__emitEvent({
					kind: "action.request",
					name: "x",
					at: "1999-01-01T00:00:00.000Z",
					ts: 999999999,
				});
				return 1;
			`),
		);
		const injected = events.find(
			(e) => e.kind === "action.request" && e.name === "x",
		);
		expect(injected).toBeDefined();
		// Guest-supplied at/ts are ignored; host stamps its own values.
		expect(injected?.at).not.toBe("1999-01-01T00:00:00.000Z");
		expect(injected?.ts).not.toBe(999_999_999);
		expect(Number.isNaN(Date.parse(injected?.at ?? ""))).toBe(false);
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

describe("sandbox timer instrumentation", () => {
	it("setTimeout awaited: emits set, request(ref=null), response; no clear", async () => {
		const { events } = await runSource(
			defaultHandler(
				"return await new Promise(resolve => setTimeout(() => resolve(42), 0));",
			),
		);
		const sets = events.filter((e) => e.kind === "timer.set");
		const requests = events.filter((e) => e.kind === "timer.request");
		const responses = events.filter((e) => e.kind === "timer.response");
		const clears = events.filter((e) => e.kind === "timer.clear");
		expect(sets).toHaveLength(1);
		expect(requests).toHaveLength(1);
		expect(responses).toHaveLength(1);
		expect(clears).toHaveLength(0);
		expect(sets[0]?.name).toBe("setTimeout");
		expect(requests[0]?.ref).toBeNull();
		expect(responses[0]?.ref).toBe(requests[0]?.seq);
		const setInput = sets[0]?.input as { delay: number; timerId: number };
		const reqInput = requests[0]?.input as { timerId: number };
		expect(setInput.timerId).toBe(reqInput.timerId);
		expect(setInput.delay).toBe(0);
	});

	it("fire-and-forget setTimeout produces auto timer.clear before trigger.response", async () => {
		const { events } = await runSource(
			defaultHandler(
				"setTimeout(() => { globalThis.__late = true; }, 5000); return 1;",
			),
		);
		const set = events.find((e) => e.kind === "timer.set");
		const clear = events.find((e) => e.kind === "timer.clear");
		const triggerResp = events.find((e) => e.kind === "trigger.response");
		expect(set).toBeDefined();
		expect(clear).toBeDefined();
		expect(clear?.name).toBe("clearTimeout");
		expect(clear?.ref).toBeNull();
		const setInput = set?.input as { timerId: number };
		const clearInput = clear?.input as { timerId: number };
		expect(clearInput.timerId).toBe(setInput.timerId);
		// Ordering: timer.clear precedes trigger.response by seq.
		expect((clear?.seq ?? 0) < (triggerResp?.seq ?? -1)).toBe(true);
		// Callback never fired.
		const requests = events.filter((e) => e.kind === "timer.request");
		expect(requests).toHaveLength(0);
	});

	it("setInterval with throwing callback emits request+error per tick and clears at end", async () => {
		const { events } = await runSource(
			defaultHandler(
				`let ticks = 0;
				const id = setInterval(() => { ticks++; throw new Error("tick-" + ticks); }, 5);
				await new Promise(resolve => setTimeout(resolve, 30));
				return ticks;`,
			),
		);
		const requests = events.filter(
			(e) => e.kind === "timer.request" && e.name === "setInterval",
		);
		const errors = events.filter((e) => e.kind === "timer.error");
		expect(requests.length).toBeGreaterThanOrEqual(2);
		expect(errors.length).toBe(requests.length);
		for (let i = 0; i < requests.length; i++) {
			expect(errors[i]?.ref).toBe(requests[i]?.seq);
		}
		const intervalClears = events.filter(
			(e) => e.kind === "timer.clear" && e.name === "clearInterval",
		);
		expect(intervalClears).toHaveLength(1);
		expect(intervalClears[0]?.ref).toBeNull();
		// Trigger completed successfully (timer.error did not promote).
		const triggerResp = events.find((e) => e.kind === "trigger.response");
		expect(triggerResp).toBeDefined();
	});

	it("nested action.request inside timer callback takes timer.request as ref", async () => {
		const { events } = await runSource(
			defaultHandler(
				`await new Promise(resolve => setTimeout(() => {
					__emitEvent({ kind: "action.request", name: "child", input: {} });
					__emitEvent({ kind: "action.response", name: "child", output: 1 });
					resolve();
				}, 0));
				return 1;`,
			),
		);
		const timerReq = events.find((e) => e.kind === "timer.request");
		const actionReq = events.find(
			(e) => e.kind === "action.request" && e.name === "child",
		);
		expect(actionReq?.ref).toBe(timerReq?.seq);
	});

	it("explicit clearTimeout emits timer.clear with stack-parent ref", async () => {
		const { events } = await runSource(
			defaultHandler(
				`const id = setTimeout(() => {}, 5000);
				clearTimeout(id);
				return 1;`,
			),
		);
		const triggerReq = events.find((e) => e.kind === "trigger.request");
		const clear = events.find((e) => e.kind === "timer.clear");
		expect(clear).toBeDefined();
		expect(clear?.name).toBe("clearTimeout");
		expect(clear?.ref).toBe(triggerReq?.seq);
	});

	it("clearTimeout on unknown id emits no event", async () => {
		const { events } = await runSource(
			defaultHandler("clearTimeout(999999); return 1;"),
		);
		const clears = events.filter((e) => e.kind === "timer.clear");
		expect(clears).toHaveLength(0);
	});

	it("trigger throws while setInterval pending: clear precedes trigger.error", async () => {
		const { events } = await runSource(
			defaultHandler(
				`setInterval(() => {}, 1000);
				throw new Error("boom");`,
			),
		);
		const clear = events.find((e) => e.kind === "timer.clear");
		const triggerErr = events.find((e) => e.kind === "trigger.error");
		expect(clear).toBeDefined();
		expect(clear?.name).toBe("clearInterval");
		expect(clear?.ref).toBeNull();
		expect(triggerErr).toBeDefined();
		expect((clear?.seq ?? 0) < (triggerErr?.seq ?? -1)).toBe(true);
	});

	it("does not introduce new globals on globalThis", async () => {
		// Boundary guard: timer instrumentation SHALL NOT add new guest-visible
		// globals. The four timer functions were already exposed; instrumenting
		// their bodies does not change the globalThis surface.
		const { result } = await runSource(
			defaultHandler(
				`const names = Object.getOwnPropertyNames(globalThis);
				names.sort();
				return names;`,
			),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const names = result.result as string[];
			expect(names).toContain("setTimeout");
			expect(names).toContain("setInterval");
			expect(names).toContain("clearTimeout");
			expect(names).toContain("clearInterval");
			// Negative: no timer-related helper leaked.
			expect(names).not.toContain("buildEvent");
			expect(names).not.toContain("__buildEvent");
			expect(names).not.toContain("__timerEmit");
			expect(names).not.toContain("emitEvent");
		}
	});

	it("does not expose host-side buildEvent to the guest", async () => {
		const { result } = await runSource(
			defaultHandler(
				`return {
					direct: typeof globalThis.buildEvent,
					prefixed: typeof globalThis.__buildEvent,
				};`,
			),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toEqual({
				direct: "undefined",
				prefixed: "undefined",
			});
		}
	});
});

describe("sandbox WASI observability", () => {
	it("in-run Date.now() emits one wasi.clock_time_get system.call event", async () => {
		const { events } = await runSource(defaultHandler("return Date.now();"));
		const clockEvents = events.filter(
			(e) => e.kind === "system.call" && e.name === "wasi.clock_time_get",
		);
		expect(clockEvents.length).toBeGreaterThanOrEqual(1);
		const first = clockEvents[0] as InvocationEvent;
		expect(first.kind).toBe("system.call");
		expect(first.input).toEqual({ clockId: "REALTIME" });
		expect(typeof (first.output as { ns?: number })?.ns).toBe("number");
		// system.call is a leaf event parented to whatever is on the refStack.
		// Pure-guest Date.now() parents to the trigger.request (seq 0).
		expect(first.ref).toBe(0);
	});

	it("in-run crypto.getRandomValues emits wasi.random_get with bufLen + sha256First16, no raw bytes", async () => {
		const { events } = await runSource(
			defaultHandler(`
				const buf = new Uint8Array(32);
				crypto.getRandomValues(buf);
				return buf.length;
			`),
		);
		const randomEvents = events.filter(
			(e) => e.kind === "system.call" && e.name === "wasi.random_get",
		);
		expect(randomEvents.length).toBeGreaterThanOrEqual(1);
		// Find the one with bufLen 32 (libc init may have requested other sizes
		// during VM creation, but those are pre-run and SHALL NOT emit).
		const target = randomEvents.find(
			(e) => (e.input as { bufLen?: number })?.bufLen === 32,
		);
		expect(target).toBeDefined();
		const output = target?.output as {
			bufLen: number;
			sha256First16: string;
		};
		expect(output.bufLen).toBe(32);
		expect(output.sha256First16).toMatch(SHA256_FIRST_16_RE);
	});

	it("performance.now() starts near zero and increases within a run", async () => {
		const { result } = await runSource(
			defaultHandler(`
				const a = performance.now();
				// Consume a bit of time: a trivial busy loop keeps everything
				// deterministic without relying on a timer.
				let acc = 0;
				for (let i = 0; i < 1000; i++) acc += i;
				const b = performance.now();
				return { a, b, acc };
			`),
		);
		if (!result.ok) {
			throw new Error(`guest error: ${result.error.message}`);
		}
		const { a, b } = result.result as { a: number; b: number };
		// Anchor is re-set at setRunContext; guest's first read should be tiny.
		expect(a).toBeLessThan(100);
		expect(b).toBeGreaterThanOrEqual(a);
	});

	it("cached sandbox: performance.now() at start of run 2 is less than end of run 1", async () => {
		const sb = await sandbox(
			defaultHandler(`
				const start = performance.now();
				let acc = 0;
				for (let i = 0; i < 5000; i++) acc += i;
				const end = performance.now();
				return { start, end, acc };
			`),
			{},
		);
		try {
			const r1 = await sb.run("default", null, RUN_OPTS);
			const r2 = await sb.run("default", null, RUN_OPTS);
			if (!(r1.ok && r2.ok)) {
				throw new Error("run failed");
			}
			const end1 = (r1.result as { end: number }).end;
			const start2 = (r2.result as { start: number }).start;
			expect(start2).toBeLessThan(end1);
		} finally {
			sb.dispose();
		}
	});

	it("trigger.request remains the first emitted event (pre-run WASI reads do not emit)", async () => {
		const { events } = await runSource(defaultHandler("return 1;"));
		expect(events[0]?.kind).toBe("trigger.request");
		expect(events[0]?.seq).toBe(0);
		// No wasi.* event may appear before the trigger.request seq.
		const wasiBeforeTrigger = events.filter(
			(e) =>
				e.kind === "system.call" &&
				typeof e.name === "string" &&
				e.name.startsWith("wasi.") &&
				e.seq < (events[0]?.seq ?? 0),
		);
		expect(wasiBeforeTrigger).toHaveLength(0);
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

describe("MCA shims", () => {
	it("self === globalThis", async () => {
		const { result } = await runSource(
			defaultHandler("return self === globalThis;"),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe(true);
		}
	});

	it("navigator.userAgent matches package version", async () => {
		const { result } = await runSource(
			defaultHandler("return navigator.userAgent;"),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe(`WorkflowEngine/${PACKAGE_VERSION}`);
		}
	});

	it("navigator is frozen", async () => {
		const { result } = await runSource(
			defaultHandler(`
				'use strict';
				try {
					navigator.foo = 'x';
					return { threw: false, foo: navigator.foo };
				} catch (e) {
					return { threw: true, foo: navigator.foo };
				}
			`),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect((result.result as { foo: unknown }).foo).toBeUndefined();
		}
	});

	it("reportError serializes Error and forwards to __reportError", async () => {
		const captured: unknown[] = [];
		const { result } = await runSource(
			defaultHandler(`
				const e = new Error("boom");
				e.stack = "mock-stack";
				reportError(e);
				return "ok";
			`),
			{
				methods: {
					__reportError: async (payload: unknown) => {
						captured.push(payload);
					},
				},
			},
		);
		expect(result.ok).toBe(true);
		expect(captured).toHaveLength(1);
		const payload = captured[0] as {
			name: string;
			message: string;
			stack?: string;
		};
		expect(payload.name).toBe("Error");
		expect(payload.message).toBe("boom");
		expect(payload.stack).toBe("mock-stack");
	});

	it("reportError serializes non-Error values", async () => {
		const captured: unknown[] = [];
		const { result } = await runSource(
			defaultHandler(`reportError("a plain string"); return "ok";`),
			{
				methods: {
					__reportError: async (payload: unknown) => {
						captured.push(payload);
					},
				},
			},
		);
		expect(result.ok).toBe(true);
		const payload = captured[0] as {
			name: string;
			message: string;
			stack?: unknown;
		};
		expect(payload.name).toBe("Error");
		expect(payload.message).toBe("a plain string");
		expect(payload.stack).toBeUndefined();
	});

	it("reportError serializes error cause recursively", async () => {
		const captured: unknown[] = [];
		const { result } = await runSource(
			defaultHandler(`
				const inner = new Error("inner");
				const outer = new Error("outer", { cause: inner });
				reportError(outer);
				return "ok";
			`),
			{
				methods: {
					__reportError: async (payload: unknown) => {
						captured.push(payload);
					},
				},
			},
		);
		expect(result.ok).toBe(true);
		const payload = captured[0] as {
			message: string;
			cause?: { message: string };
		};
		expect(payload.message).toBe("outer");
		expect(payload.cause?.message).toBe("inner");
	});

	it("per-run extraMethods.__reportError overrides construction-time methods.__reportError", async () => {
		const constructionCaptured: unknown[] = [];
		const runCaptured: unknown[] = [];
		const sb = await sandbox(defaultHandler(`reportError(new Error("hi"));`), {
			__reportError: async (payload: unknown) => {
				constructionCaptured.push(payload);
			},
		});
		try {
			await sb.run(
				"default",
				{},
				{
					...RUN_OPTS,
					extraMethods: {
						__reportError: async (payload: unknown) => {
							runCaptured.push(payload);
						},
					},
				},
			);
			expect(runCaptured).toHaveLength(1);
			expect(constructionCaptured).toHaveLength(0);
		} finally {
			sb.dispose();
		}
	});

	it("reportError swallows getter-throws instead of propagating into guest", async () => {
		const captured: unknown[] = [];
		const { result } = await runSource(
			defaultHandler(`
				const evil = {};
				Object.defineProperty(evil, "message", {
					get() { throw new Error("getter-throw"); },
				});
				Object.defineProperty(evil, "stack", {
					get() { throw new Error("stack-throw"); },
				});
				reportError(evil);
				return "ok";
			`),
			{
				methods: {
					__reportError: async (payload: unknown) => {
						captured.push(payload);
					},
				},
			},
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe("ok");
		}
		expect(captured).toHaveLength(1);
		const payload = captured[0] as {
			name: string;
			message: string;
			stack?: unknown;
		};
		expect(payload.name).toBe("Error");
		expect(typeof payload.message).toBe("string");
	});

	it("__reportError absent throws ReferenceError when called directly", async () => {
		const { result } = await runSource(
			defaultHandler(`
				try {
					__reportError({ message: "x" });
					return { threw: false };
				} catch (e) {
					return { threw: true, name: e.name };
				}
			`),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const r = result.result as { threw: boolean; name?: string };
			expect(r.threw).toBe(true);
			expect(r.name).toBe("ReferenceError");
		}
	});
});
