import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import { describe, expect, it } from "vitest";
import { type Bridge, createBridge } from "./bridge.js";
import type { WireEvent } from "./protocol.js";
import type { AnchorCell } from "./wasi.js";

// `createBridge` doesn't dereference the VM in the code paths we're
// testing (buildEvent + emit + sink + setRunActive). The marshal helpers
// and arg extractors DO touch the VM, but those aren't exercised here.
// Use a minimal VM stand-in.
const fakeVm = {} as unknown as QuickJS;

function freshAnchor(): AnchorCell {
	return { ns: 0n };
}

// All buildEvent tests need an active run window — mirrors how the
// worker's `handleRun` calls `setRunActive` before any guest emission.
function activeBridge(events: WireEvent[]): Bridge {
	const bridge = createBridge(fakeVm, freshAnchor());
	bridge.setSink((e) => events.push(e));
	bridge.setRunActive();
	return bridge;
}

describe("Bridge.buildEvent — wire shape", () => {
	it("produces a leaf wire event with type:'leaf' for default framing", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		bridge.buildEvent("system.call", "console.log", "leaf", {
			input: { args: ["hello"] },
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("system.call");
		expect(events[0]?.name).toBe("console.log");
		expect(events[0]?.type).toBe("leaf");
		expect(events[0]?.input).toEqual({ args: ["hello"] });
		// Critical: no seq, no ref on the wire — those are stamped main-side.
		expect("seq" in (events[0] ?? {})).toBe(false);
		expect("ref" in (events[0] ?? {})).toBe(false);
	});

	it("mints a callId and emits {open: id} for type:'open'", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		const id = bridge.buildEvent("trigger.request", "demo", "open", {
			input: { x: 1 },
		});

		expect(typeof id).toBe("number");
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toEqual({ open: id });
	});

	it("mints a fresh callId for each open in a run", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		const a = bridge.buildEvent("system.request", "fetchA", "open", {});
		const b = bridge.buildEvent("system.request", "fetchB", "open", {});
		const c = bridge.buildEvent("system.request", "fetchC", "open", {});

		expect(a).toBe(0);
		expect(b).toBe(1);
		expect(c).toBe(2);
		expect(events.map((e) => e.type)).toEqual([
			{ open: 0 },
			{ open: 1 },
			{ open: 2 },
		]);
	});

	it("echoes the supplied callId on type:{close: id} unchanged", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		bridge.buildEvent(
			"trigger.response",
			"demo",
			{ close: 42 },
			{ output: { ok: true } },
		);

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toEqual({ close: 42 });
		expect(events[0]?.output).toEqual({ ok: true });
	});

	it("resetCallIds zeroes the callId counter for the next run", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		bridge.buildEvent("system.request", "a", "open", {});
		bridge.buildEvent("system.request", "b", "open", {});
		// New run cycle: clearRunActive + resetCallIds + setRunActive.
		// resetCallIds is the dedicated counter-zero operation; setRunActive
		// is now a pure boolean toggle.
		bridge.clearRunActive();
		bridge.resetCallIds();
		bridge.setRunActive();
		const c = bridge.buildEvent("system.request", "c", "open", {});

		expect(c).toBe(0);
		expect(events[2]?.type).toEqual({ open: 0 });
	});

	it("setRunActive without resetCallIds preserves the counter (split contract)", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		bridge.buildEvent("system.request", "a", "open", {});
		bridge.clearRunActive();
		bridge.setRunActive();
		// No resetCallIds — counter continues from where it left off.
		const next = bridge.buildEvent("system.request", "b", "open", {});

		expect(next).toBe(1);
	});

	it("populates ts and at on every event", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		bridge.buildEvent("system.call", "x", "leaf", {});

		expect(typeof events[0]?.ts).toBe("number");
		expect(typeof events[0]?.at).toBe("string");
		// at is an ISO 8601 wall-clock string
		expect(() => new Date(events[0]?.at ?? "").toISOString()).not.toThrow();
	});

	it("includes only present payload fields", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		// No input/output/error provided
		bridge.buildEvent("system.call", "x", "leaf", {});
		expect("input" in (events[0] ?? {})).toBe(false);
		expect("output" in (events[0] ?? {})).toBe(false);
		expect("error" in (events[0] ?? {})).toBe(false);

		// Only error provided
		bridge.buildEvent(
			"system.error",
			"x",
			{ close: 0 },
			{
				error: { message: "boom", stack: "" },
			},
		);
		expect(events[1]?.error).toEqual({ message: "boom", stack: "" });
		expect("input" in (events[1] ?? {})).toBe(false);
		expect("output" in (events[1] ?? {})).toBe(false);
	});
});

describe("Bridge.buildEvent — runActive gating", () => {
	it("returns 0 and emits nothing when runActive is false (init/post-run window)", () => {
		const events: WireEvent[] = [];
		const bridge = createBridge(fakeVm, freshAnchor());
		bridge.setSink((e) => events.push(e));
		// runActive defaults to false — emulate Phase-4 / pre-`setRunActive`
		// init window where guest source eval can call host bridges
		// (e.g. WPT test bodies running synchronously during eval).
		const id = bridge.buildEvent("system.call", "console.log", "leaf", {
			input: { args: [Symbol.for("init-time")] },
		});

		expect(id).toBe(0);
		expect(events).toHaveLength(0);
	});

	it("does not mint callIds for opens emitted outside the active window", () => {
		const events: WireEvent[] = [];
		const bridge = createBridge(fakeVm, freshAnchor());
		bridge.setSink((e) => events.push(e));

		const a = bridge.buildEvent("system.request", "fetch", "open", {});
		const b = bridge.buildEvent("system.request", "fetch", "open", {});

		expect(a).toBe(0);
		expect(b).toBe(0);
		expect(events).toHaveLength(0);

		// Once active, the counter starts at 0 (fresh run).
		bridge.setRunActive();
		const c = bridge.buildEvent("system.request", "fetch", "open", {});
		expect(c).toBe(0);
	});

	it("clearRunActive suppresses subsequent emissions (post-run window)", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		bridge.buildEvent("system.call", "x", "leaf", {});
		expect(events).toHaveLength(1);

		bridge.clearRunActive();
		bridge.buildEvent("system.call", "late", "leaf", {});
		expect(events).toHaveLength(1);
	});
});

describe("Bridge.emit — sink dispatch", () => {
	it("emits to the installed sink, drops when sink is null", () => {
		const events: WireEvent[] = [];
		const bridge = activeBridge(events);

		bridge.buildEvent("system.call", "a", "leaf", {});
		expect(events).toHaveLength(1);

		bridge.setSink(null);
		bridge.buildEvent("system.call", "b", "leaf", {});
		expect(events).toHaveLength(1);
	});
});

// Regression: a host Promise marshalled into a VM that is disposed before
// the promise resolves used to crash the worker via quickjs-wasi's
// unguarded `.then(r => deferred.resolve(vm.hostToHandle(r)))` callback
// (see safeHostToHandle in bridge.ts). The wrapper must silently no-op the
// late resolution instead of throwing into the unhandled-rejection path.
describe("Bridge.hostToHandle — Promise marshalling vs late dispose", () => {
	it("does not throw an unhandled rejection when the VM is disposed before the promise resolves", async () => {
		let pendingResolve: ((value: unknown) => void) | undefined;
		const pending = new Promise((resolve) => {
			pendingResolve = resolve;
		});

		const deferredHandle = {} as JSValueHandle;
		let disposed = false;
		const fakeDeferred = {
			handle: deferredHandle,
			resolve: (_h: JSValueHandle) => {
				if (disposed) {
					throw new Error("QuickJS instance has been disposed");
				}
			},
			reject: (_h: JSValueHandle) => {
				if (disposed) {
					throw new Error("QuickJS instance has been disposed");
				}
			},
		};
		const stubVm = {
			newPromise: () => {
				if (disposed) {
					throw new Error("QuickJS instance has been disposed");
				}
				return fakeDeferred;
			},
			hostToHandle: (_v: unknown) => {
				if (disposed) {
					throw new Error("QuickJS instance has been disposed");
				}
				return {} as JSValueHandle;
			},
			executePendingJobs: () => {
				if (disposed) {
					throw new Error("QuickJS instance has been disposed");
				}
			},
		} as unknown as QuickJS;

		const unhandled: unknown[] = [];
		const onReject = (err: unknown) => unhandled.push(err);
		process.on("unhandledRejection", onReject);

		try {
			const bridge = createBridge(stubVm, freshAnchor());
			const handle = bridge.hostToHandle(pending);
			expect(handle).toBe(deferredHandle);

			disposed = true;
			pendingResolve?.("late");

			// Yield twice so any unhandled rejection from the .then microtask
			// has a chance to surface.
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onReject);
		}
	});

	it("rejects nested Promise inside an object/array tree (dev-mode assertion)", () => {
		const stubVm = {
			hostToHandle: () => ({}) as JSValueHandle,
		} as unknown as QuickJS;
		const bridge = createBridge(stubVm, freshAnchor());
		expect(() => bridge.hostToHandle({ data: Promise.resolve(1) })).toThrow(
			/nested Promise not supported/,
		);
		expect(() => bridge.hostToHandle([1, 2, Promise.resolve(3)])).toThrow(
			/nested Promise not supported/,
		);
	});
});
