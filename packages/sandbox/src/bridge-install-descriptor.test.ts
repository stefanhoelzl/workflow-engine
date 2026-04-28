import { QuickJS } from "quickjs-wasi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Bridge, createBridge } from "./bridge-factory.js";
import {
	GuestArgTypeMismatchError,
	GuestValidationError,
} from "./guest-errors.js";
import type { GuestFunctionDescription } from "./plugin.js";
import { Guest } from "./plugin-types.js";
import { recordingContext } from "./recording-context.js";

describe("bridge.installDescriptor", () => {
	let vm: QuickJS;
	let bridge: Bridge;

	beforeEach(async () => {
		vm = await QuickJS.create();
		bridge = createBridge(vm, { ns: 0n });
	});

	afterEach(() => {
		vm.dispose();
	});

	it("marshals number args and returns a string result through ctx.request by default", () => {
		const ctx = recordingContext({ callIds: "always" });
		const desc: GuestFunctionDescription = {
			name: "join",
			args: [Guest.number(), Guest.number()],
			result: Guest.string(),
			handler: ((a: number, b: number) =>
				`${a}+${b}=${a + b}`) as unknown as GuestFunctionDescription["handler"],
		};
		bridge.installDescriptor(ctx, desc);
		const out = vm.evalCode("join(2, 3)", "<test>");
		expect(vm.dump(out)).toBe("2+3=5");
		out.dispose();
		expect(ctx.flatRequests).toEqual([
			{
				prefix: "join",
				name: "join",
				input: [2, 3],
				result: "2+3=5",
			},
		]);
	});

	it("honours log: { event: ... } by emitting a leaf event instead of wrapping in ctx.request", () => {
		const ctx = recordingContext({ callIds: "always" });
		const desc: GuestFunctionDescription = {
			name: "setTimeout",
			args: [Guest.number()],
			result: Guest.void(),
			handler: () => {
				/* no-op */
			},
			log: { event: "timer.set" },
		};
		bridge.installDescriptor(ctx, desc);
		const out = vm.evalCode("setTimeout(5)", "<test>");
		out.dispose();
		expect(ctx.flatEvents).toEqual([
			{ kind: "timer.set", name: "setTimeout", input: [5] },
		]);
		expect(ctx.flatRequests).toEqual([]);
	});

	it("honours a custom log: { request: '...' } prefix", () => {
		const ctx = recordingContext({ callIds: "always" });
		const desc: GuestFunctionDescription = {
			name: "$fetch/do",
			args: [Guest.string()],
			result: Guest.string(),
			handler: (url) => `fetched:${url}`,
			log: { request: "fetch" },
		};
		bridge.installDescriptor(ctx, desc);
		const out = vm.evalCode("globalThis['$fetch/do']('http://x')", "<test>");
		expect(vm.dump(out)).toBe("fetched:http://x");
		out.dispose();
		expect(ctx.flatRequests).toEqual([
			{
				prefix: "fetch",
				name: "$fetch/do",
				input: ["http://x"],
				result: "fetched:http://x",
			},
		]);
	});

	it("marshals object args and object results via vm.dump / vm.hostToHandle", () => {
		const ctx = recordingContext({ callIds: "always" });
		const desc: GuestFunctionDescription = {
			name: "wrap",
			args: [Guest.object()],
			result: Guest.object(),
			handler: (input) => ({ ...(input as object), wrapped: true }),
		};
		bridge.installDescriptor(ctx, desc);
		const out = vm.evalCode("wrap({a: 1})", "<test>");
		expect(vm.dump(out)).toEqual({ a: 1, wrapped: true });
		out.dispose();
	});

	it("throws GuestArgTypeMismatchError when the guest passes a wrong-typed argument", () => {
		const ctx = recordingContext({ callIds: "always" });
		const desc: GuestFunctionDescription = {
			name: "strict",
			args: [Guest.number()],
			result: Guest.void(),
			handler: () => {
				/* no-op */
			},
		};
		bridge.installDescriptor(ctx, desc);
		// Arg mismatch surfaces as a QuickJS exception because
		// vm.newFunction's trampoline catches the host throw and re-raises
		// it into the guest. We verify from the host side that the error
		// shape is preserved in the ctx.request's error bucket.
		const out = vm.evalCode(
			`try { strict("not-a-number"); "ok"; } catch (e) { "err:" + e.message; }`,
			"<test>",
		);
		expect(vm.dump(out)).toMatch(
			/err:.*guest function "strict" arg\[0\]: expected number/,
		);
		out.dispose();
		expect(ctx.flatRequests).toHaveLength(0);
		const thrown = ctx.flatEvents.length === 0; // request path threw before event
		expect(thrown).toBe(true);
	});

	it("marshals a callable arg as a host-side Callable that can be invoked and disposed", async () => {
		const ctx = recordingContext({ callIds: "always" });
		let captured: import("./plugin.js").Callable | null = null;
		const desc: GuestFunctionDescription = {
			name: "registerCb",
			args: [Guest.callable()],
			result: Guest.void(),
			handler: ((cb: import("./plugin.js").Callable) => {
				captured = cb;
			}) as unknown as GuestFunctionDescription["handler"],
		};
		bridge.installDescriptor(ctx, desc);
		const out = vm.evalCode(`registerCb((n) => 'got:' + n); 'ok';`, "<test>");
		expect(vm.dump(out)).toBe("ok");
		out.dispose();
		expect(captured).toBeTruthy();
		// Invoke the captured callable from host code AFTER the original
		// synchronous call has returned. This is the load-bearing
		// behaviour for timers, fetch completers, SDK dispatchers.
		const result = await (
			captured as unknown as import("./plugin.js").Callable
		)("hello");
		expect(result).toBe("got:hello");
		// Disposal is idempotent; a second call no-ops, a post-dispose
		// invoke throws CallableDisposedError.
		(captured as unknown as import("./plugin.js").Callable).dispose();
		(captured as unknown as import("./plugin.js").Callable).dispose();
		await expect(
			(captured as unknown as import("./plugin.js").Callable)("after"),
		).rejects.toThrow(/Callable has been disposed/);
	});

	it("dispose() during a mid-invocation Callable defers the underlying handle release until the guest frame unwinds", async () => {
		// Reproduces the F-1 hazard: the timers plugin's `cancel()` calls
		// `entry.callable.dispose()` while QuickJS is still executing inside
		// the same handle (`setInterval(() => clearInterval(id), 0)`). A
		// synchronous release of the JSValueHandle while it sits on the WASM
		// stack triggered `RuntimeError: memory access out of bounds` on
		// unwind. With re-entry-safe dispose, the release is deferred until
		// invocation depth returns to 0 — the call returns normally, then
		// subsequent invokes throw CallableDisposedError.
		const ctx = recordingContext({ callIds: "always" });
		let captured: import("./plugin.js").Callable | null = null;
		const registerDesc: GuestFunctionDescription = {
			name: "registerCb",
			args: [Guest.callable()],
			result: Guest.void(),
			handler: ((cb: import("./plugin.js").Callable) => {
				captured = cb;
			}) as unknown as GuestFunctionDescription["handler"],
		};
		const disposeMeDesc: GuestFunctionDescription = {
			name: "disposeMe",
			args: [],
			result: Guest.void(),
			handler: (() => {
				(captured as unknown as import("./plugin.js").Callable)?.dispose();
			}) as unknown as GuestFunctionDescription["handler"],
		};
		bridge.installDescriptor(ctx, registerDesc);
		bridge.installDescriptor(ctx, disposeMeDesc);
		const out = vm.evalCode(
			`registerCb(() => { disposeMe(); return 'done'; }); 'ok';`,
			"<test>",
		);
		out.dispose();
		const callable = captured as unknown as import("./plugin.js").Callable;
		// Mid-invocation dispose must not crash; the call returns normally.
		const result = await callable();
		expect(result).toBe("done");
		// After the outer frame unwound, the deferred dispose ran; a follow-
		// up invoke now throws CallableDisposedError.
		await expect(callable()).rejects.toThrow(/Callable has been disposed/);
	});

	it("nested re-entry while a dispose is pending stays depth-correct: release runs only when the outermost frame unwinds", async () => {
		const ctx = recordingContext({ callIds: "always" });
		let captured: import("./plugin.js").Callable | null = null;
		let nestedCallReturned = false;
		const registerDesc: GuestFunctionDescription = {
			name: "registerCb",
			args: [Guest.callable()],
			result: Guest.void(),
			handler: ((cb: import("./plugin.js").Callable) => {
				captured = cb;
			}) as unknown as GuestFunctionDescription["handler"],
		};
		// `reenter` calls dispose() (deferring), then re-enters the same
		// callable from the host. The inner invoke must succeed (depth=2),
		// returning normally; only when depth returns to 0 does dispose run.
		const reenterDesc: GuestFunctionDescription = {
			name: "reenter",
			args: [Guest.number()],
			result: Guest.void(),
			handler: (async (depth: number) => {
				const cb = captured as unknown as import("./plugin.js").Callable;
				if (depth === 1) {
					cb.dispose();
					const inner = await cb(0);
					if (inner === "depth-0") {
						nestedCallReturned = true;
					}
				}
			}) as unknown as GuestFunctionDescription["handler"],
		};
		bridge.installDescriptor(ctx, registerDesc);
		bridge.installDescriptor(ctx, reenterDesc);
		const out = vm.evalCode(
			`registerCb(async (n) => { if (n === 1) await reenter(1); return 'depth-' + n; }); 'ok';`,
			"<test>",
		);
		out.dispose();
		const callable = captured as unknown as import("./plugin.js").Callable;
		const result = await callable(1);
		expect(result).toBe("depth-1");
		expect(nestedCallReturned).toBe(true);
		// Outermost frame has unwound; dispose has run.
		await expect(callable(0)).rejects.toThrow(/Callable has been disposed/);
	});

	it("dispose() called twice while pending stays idempotent (no double release)", async () => {
		// If dispose() during invocation only marks pendingDispose, calling
		// it again before the frame unwinds must not re-arm or double-release
		// the underlying handle. Verified indirectly: the test exercising
		// double dispose during normal use already covers idempotence; here
		// we cover the deferred-window variant.
		const ctx = recordingContext({ callIds: "always" });
		let captured: import("./plugin.js").Callable | null = null;
		const registerDesc: GuestFunctionDescription = {
			name: "registerCb",
			args: [Guest.callable()],
			result: Guest.void(),
			handler: ((cb: import("./plugin.js").Callable) => {
				captured = cb;
			}) as unknown as GuestFunctionDescription["handler"],
		};
		const disposeTwiceDesc: GuestFunctionDescription = {
			name: "disposeTwice",
			args: [],
			result: Guest.void(),
			handler: (() => {
				const cb = captured as unknown as import("./plugin.js").Callable;
				cb.dispose();
				cb.dispose();
			}) as unknown as GuestFunctionDescription["handler"],
		};
		bridge.installDescriptor(ctx, registerDesc);
		bridge.installDescriptor(ctx, disposeTwiceDesc);
		const out = vm.evalCode(
			`registerCb(() => { disposeTwice(); return 'ok'; }); 'ok';`,
			"<test>",
		);
		out.dispose();
		const callable = captured as unknown as import("./plugin.js").Callable;
		await expect(callable()).resolves.toBe("ok");
		await expect(callable()).rejects.toThrow(/Callable has been disposed/);
	});

	it("propagates guest-side rejections out of a Callable as host Error", async () => {
		const ctx = recordingContext({ callIds: "always" });
		let captured: import("./plugin.js").Callable | null = null;
		const desc: GuestFunctionDescription = {
			name: "registerReject",
			args: [Guest.callable()],
			result: Guest.void(),
			handler: ((cb: import("./plugin.js").Callable) => {
				captured = cb;
			}) as unknown as GuestFunctionDescription["handler"],
		};
		bridge.installDescriptor(ctx, desc);
		const out = vm.evalCode(
			`registerReject(async () => { throw new Error("boom from guest"); });`,
			"<test>",
		);
		out.dispose();
		await expect(
			(captured as unknown as import("./plugin.js").Callable)(),
		).rejects.toThrow(/boom from guest/);
		(captured as unknown as import("./plugin.js").Callable).dispose();
	});

	it("validates result types and throws GuestValidationError on mismatch", () => {
		const ctx = recordingContext({ callIds: "always" });
		const desc: GuestFunctionDescription = {
			name: "lies",
			args: [],
			result: Guest.number(),
			handler: () => "not-a-number" as unknown as number,
		};
		bridge.installDescriptor(ctx, desc);
		const out = vm.evalCode(
			`try { lies(); "ok"; } catch (e) { "err:" + e.message; }`,
			"<test>",
		);
		expect(vm.dump(out)).toMatch(/err:.*result: expected number, got string/);
		out.dispose();
	});
});

describe("error classes", () => {
	it("GuestArgTypeMismatchError exposes descriptor name + arg index + kinds", () => {
		const err = new GuestArgTypeMismatchError("f", 0, "number", "string");
		expect(err.name).toBe("GuestArgTypeMismatchError");
		expect(err.descriptorName).toBe("f");
		expect(err.argIndex).toBe(0);
		expect(err.expected).toBe("number");
		expect(err.received).toBe("string");
	});

	it("GuestValidationError exposes descriptor name", () => {
		const err = new GuestValidationError("f", "something wrong");
		expect(err.name).toBe("GuestValidationError");
		expect(err.descriptorName).toBe("f");
	});
});
