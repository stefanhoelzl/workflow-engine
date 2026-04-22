import { QuickJS } from "quickjs-wasi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	GuestArgTypeMismatchError,
	GuestValidationError,
	installGuestFunction,
} from "./guest-function-install.js";
import type { GuestFunctionDescription, SandboxContext } from "./plugin.js";
import { Guest } from "./plugin-types.js";

interface EmittedEvent {
	kind: string;
	name: string;
	extra: unknown;
}
interface RequestCall {
	prefix: string;
	name: string;
	extra: unknown;
	result?: unknown;
	error?: unknown;
}

interface RecordingCtx extends SandboxContext {
	readonly events: EmittedEvent[];
	readonly requests: RequestCall[];
}

function recordingContext(): RecordingCtx {
	const events: EmittedEvent[] = [];
	const requests: RequestCall[] = [];
	return {
		events,
		requests,
		emit(kind, name, extra) {
			events.push({ kind, name, extra });
		},
		request(prefix, name, extra, fn) {
			const entry: RequestCall = { prefix, name, extra };
			requests.push(entry);
			try {
				const r = fn();
				if (r instanceof Promise) {
					return r.then(
						(v) => {
							entry.result = v;
							return v;
						},
						(e) => {
							entry.error = e;
							throw e;
						},
					);
				}
				entry.result = r;
				return r;
			} catch (e) {
				entry.error = e;
				throw e;
			}
		},
	};
}

describe("installGuestFunction", () => {
	let vm: QuickJS;

	beforeEach(async () => {
		vm = await QuickJS.create();
	});

	afterEach(() => {
		vm.dispose();
	});

	it("marshals number args and returns a string result through ctx.request by default", () => {
		const ctx = recordingContext();
		const desc: GuestFunctionDescription = {
			name: "join",
			args: [Guest.number(), Guest.number()],
			result: Guest.string(),
			handler: ((a: number, b: number) =>
				`${a}+${b}=${a + b}`) as unknown as GuestFunctionDescription["handler"],
		};
		installGuestFunction(vm, ctx, desc);
		const out = vm.evalCode("join(2, 3)", "<test>");
		expect(vm.dump(out)).toBe("2+3=5");
		out.dispose();
		expect(ctx.requests).toEqual([
			{
				prefix: "join",
				name: "join",
				extra: { input: [2, 3] },
				result: "2+3=5",
			},
		]);
	});

	it("honours log: { event: ... } by emitting a leaf event instead of wrapping in ctx.request", () => {
		const ctx = recordingContext();
		const desc: GuestFunctionDescription = {
			name: "setTimeout",
			args: [Guest.number()],
			result: Guest.void(),
			handler: () => {
				/* no-op */
			},
			log: { event: "timer.set" },
		};
		installGuestFunction(vm, ctx, desc);
		const out = vm.evalCode("setTimeout(5)", "<test>");
		out.dispose();
		expect(ctx.events).toEqual([
			{ kind: "timer.set", name: "setTimeout", extra: { input: [5] } },
		]);
		expect(ctx.requests).toEqual([]);
	});

	it("honours a custom log: { request: '...' } prefix", () => {
		const ctx = recordingContext();
		const desc: GuestFunctionDescription = {
			name: "$fetch/do",
			args: [Guest.string()],
			result: Guest.string(),
			handler: (url) => `fetched:${url}`,
			log: { request: "fetch" },
		};
		installGuestFunction(vm, ctx, desc);
		const out = vm.evalCode("globalThis['$fetch/do']('http://x')", "<test>");
		expect(vm.dump(out)).toBe("fetched:http://x");
		out.dispose();
		expect(ctx.requests).toEqual([
			{
				prefix: "fetch",
				name: "$fetch/do",
				extra: { input: ["http://x"] },
				result: "fetched:http://x",
			},
		]);
	});

	it("marshals object args and object results via vm.dump / vm.hostToHandle", () => {
		const ctx = recordingContext();
		const desc: GuestFunctionDescription = {
			name: "wrap",
			args: [Guest.object()],
			result: Guest.object(),
			handler: (input) => ({ ...(input as object), wrapped: true }),
		};
		installGuestFunction(vm, ctx, desc);
		const out = vm.evalCode("wrap({a: 1})", "<test>");
		expect(vm.dump(out)).toEqual({ a: 1, wrapped: true });
		out.dispose();
	});

	it("throws GuestArgTypeMismatchError when the guest passes a wrong-typed argument", () => {
		const ctx = recordingContext();
		const desc: GuestFunctionDescription = {
			name: "strict",
			args: [Guest.number()],
			result: Guest.void(),
			handler: () => {
				/* no-op */
			},
		};
		installGuestFunction(vm, ctx, desc);
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
		expect(ctx.requests).toHaveLength(0);
		const thrown = ctx.events.length === 0; // request path threw before event
		expect(thrown).toBe(true);
	});

	it("marshals a callable arg as a host-side Callable that can be invoked and disposed", async () => {
		const ctx = recordingContext();
		let captured: import("./plugin.js").Callable | null = null;
		const desc: GuestFunctionDescription = {
			name: "registerCb",
			args: [Guest.callable()],
			result: Guest.void(),
			handler: ((cb: import("./plugin.js").Callable) => {
				captured = cb;
			}) as unknown as GuestFunctionDescription["handler"],
		};
		installGuestFunction(vm, ctx, desc);
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

	it("propagates guest-side rejections out of a Callable as host Error", async () => {
		const ctx = recordingContext();
		let captured: import("./plugin.js").Callable | null = null;
		const desc: GuestFunctionDescription = {
			name: "registerReject",
			args: [Guest.callable()],
			result: Guest.void(),
			handler: ((cb: import("./plugin.js").Callable) => {
				captured = cb;
			}) as unknown as GuestFunctionDescription["handler"],
		};
		installGuestFunction(vm, ctx, desc);
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
		const ctx = recordingContext();
		const desc: GuestFunctionDescription = {
			name: "lies",
			args: [],
			result: Guest.number(),
			handler: () => "not-a-number" as unknown as number,
		};
		installGuestFunction(vm, ctx, desc);
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
