import type {
	Callable,
	PluginContext,
	PluginRunResult,
	RunInput,
} from "@workflow-engine/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { name as TIMERS_PLUGIN_NAME, worker } from "./index.js";

type GuestDescriptor = NonNullable<
	ReturnType<typeof worker> extends { guestFunctions?: infer G } ? G : never
>[number];

interface EmittedEvent {
	kind: string;
	name: string;
	extra: unknown;
}

interface RecordingCtx extends PluginContext {
	events: EmittedEvent[];
}

function recordingCtx(): RecordingCtx {
	const events: EmittedEvent[] = [];
	let nextCallId = 0;
	return {
		events,
		emit(kind, options) {
			events.push({
				kind,
				name: options.name,
				extra: {
					...(options.input === undefined ? {} : { input: options.input }),
					...(options.output === undefined ? {} : { output: options.output }),
					...(options.error === undefined ? {} : { error: options.error }),
				},
			});
			if (options.type === "open") {
				return nextCallId++ as never;
			}
			return 0 as never;
		},
		request(prefix, options, fn) {
			// Real sandbox emission would be <prefix>.request/response/error;
			// the timers plugin only needs to observe that ctx.request is
			// called with the right prefix and input, not replicate the
			// full seq/ref stamping. Record as a synthetic event for test
			// observability.
			const input = options.input;
			events.push({
				kind: `${prefix}.request`,
				name: options.name,
				extra: { input },
			});
			try {
				const r = fn();
				if (r instanceof Promise) {
					return r.then(
						(v) => {
							events.push({
								kind: `${prefix}.response`,
								name: options.name,
								extra: { input, output: v },
							});
							return v;
						},
						(e: unknown) => {
							events.push({
								kind: `${prefix}.error`,
								name: options.name,
								extra: { input, error: e },
							});
							throw e;
						},
					);
				}
				events.push({
					kind: `${prefix}.response`,
					name: options.name,
					extra: { input, output: r },
				});
				return r;
			} catch (e) {
				events.push({
					kind: `${prefix}.error`,
					name: options.name,
					extra: { input, error: e },
				});
				throw e;
			}
		},
	};
}

// Minimal Callable stub for unit tests — records each invocation and
// disposal without needing a real VM.
interface TestCallable extends Callable {
	invocations: number;
	disposed: boolean;
}

function stubCallable(impl: () => unknown = () => undefined): TestCallable {
	const state = { invocations: 0, disposed: false };
	const invoke = async () => {
		state.invocations++;
		return impl() as never;
	};
	Object.defineProperty(invoke, "invocations", {
		get: () => state.invocations,
	});
	Object.defineProperty(invoke, "disposed", {
		get: () => state.disposed,
	});
	(invoke as unknown as { dispose: () => void }).dispose = () => {
		state.disposed = true;
	};
	return invoke as unknown as TestCallable;
}

const RUN_INPUT: RunInput = { name: "t", input: undefined };
const OK: PluginRunResult = { ok: true, output: undefined };

describe("createTimersPlugin", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("has the expected plugin name", () => {
		expect(TIMERS_PLUGIN_NAME).toBe("timers");
	});

	it("exposes four public descriptors with the right log shapes", async () => {
		const ctx = recordingCtx();
		const setup = worker(ctx);
		const descs = setup.guestFunctions ?? [];
		const byName = Object.fromEntries(
			descs.map((d: GuestDescriptor) => [d.name, d]),
		);
		expect(Object.keys(byName).sort()).toEqual(
			["clearInterval", "clearTimeout", "setInterval", "setTimeout"].sort(),
		);
		expect(byName.setTimeout?.public).toBe(true);
		expect(byName.setTimeout?.log).toEqual({ event: "system.call" });
		expect(byName.setInterval?.log).toEqual({ event: "system.call" });
		expect(byName.clearTimeout?.log).toEqual({ event: "system.call" });
		expect(byName.clearInterval?.log).toEqual({ event: "system.call" });
	});

	it("setTimeout schedules a Node timer that invokes the callable via ctx.request when it fires", async () => {
		const ctx = recordingCtx();
		const setup = worker(ctx);
		const setTimeoutDesc = setup.guestFunctions?.find(
			(d: GuestDescriptor) => d.name === "setTimeout",
		);
		expect(setTimeoutDesc).toBeDefined();
		const cb = stubCallable();
		// Simulate the installer's log:event auto-wrap having already
		// emitted the timer.set leaf, then call the handler body.
		const id = (
			setTimeoutDesc?.handler as unknown as (
				cb: Callable,
				delay: number,
			) => number
		)(cb, 10);
		expect(typeof id).toBe("number");
		// Fast-forward Node timers so the setTimeout callback fires; use
		// the async variant so the ctx.request's .then continuation (the
		// timer.response emit) flushes through the microtask queue before
		// we assert.
		await vi.advanceTimersByTimeAsync(20);
		expect(ctx.events.map((e) => e.kind)).toEqual([
			"system.request",
			"system.response",
		]);
		expect(cb.invocations).toBe(1);
		expect(cb.disposed).toBe(true);
	});

	it("setInterval keeps firing until cleared; cleared callable is disposed", async () => {
		const ctx = recordingCtx();
		const setup = worker(ctx);
		const setIntervalDesc = setup.guestFunctions?.find(
			(d: GuestDescriptor) => d.name === "setInterval",
		);
		const clearIntervalDesc = setup.guestFunctions?.find(
			(d: GuestDescriptor) => d.name === "clearInterval",
		);
		const cb = stubCallable();
		const id = (
			setIntervalDesc?.handler as unknown as (
				cb: Callable,
				delay: number,
			) => number
		)(cb, 5);
		vi.advanceTimersByTime(12);
		expect(cb.invocations).toBe(2);
		// Clear
		(clearIntervalDesc?.handler as unknown as (id: number) => void)(id);
		vi.advanceTimersByTime(20);
		expect(cb.invocations).toBe(2); // no further fires
		expect(cb.disposed).toBe(true);
	});

	it("onRunFinished emits timer.clear for every still-pending timer and disposes their callables", async () => {
		const ctx = recordingCtx();
		const setup = worker(ctx);
		const setTimeoutDesc = setup.guestFunctions?.find(
			(d: GuestDescriptor) => d.name === "setTimeout",
		);
		const cb1 = stubCallable();
		const cb2 = stubCallable();
		(
			setTimeoutDesc?.handler as unknown as (
				cb: Callable,
				delay: number,
			) => number
		)(cb1, 1000);
		(
			setTimeoutDesc?.handler as unknown as (
				cb: Callable,
				delay: number,
			) => number
		)(cb2, 2000);
		// Don't advance — both remain pending.
		setup.onRunFinished?.(OK, RUN_INPUT);
		const clears = ctx.events.filter(
			(e) => e.kind === "system.call" && e.name === "clearTimeout",
		);
		expect(clears).toHaveLength(2);
		expect(cb1.disposed).toBe(true);
		expect(cb2.disposed).toBe(true);
		// Advancing now should NOT fire the cleared timers.
		vi.advanceTimersByTime(5000);
		expect(cb1.invocations).toBe(0);
		expect(cb2.invocations).toBe(0);
	});

	it("setInterval callback that synchronously calls clearInterval(id) for its own id stops cleanly without re-firing or throwing (F-1 plugin-side regression)", async () => {
		// F-1 reproducer at the plugin layer. The crash itself was a WASM
		// trap inside QuickJS — covered by the real-VM test elsewhere — but
		// the plugin-side invariant is observable: cancel-during-fire must
		// (a) stop the Node interval, (b) prevent further callable
		// invocations, and (c) not throw. With the re-entry-safe Callable in
		// the sandbox layer, the timers plugin's straight-line dispose call
		// in cancel() is now safe; this test pins that the timers plugin
		// itself does not regress to a shape that depends on synchronous
		// release.
		const ctx = recordingCtx();
		const setup = worker(ctx);
		const setIntervalDesc = setup.guestFunctions?.find(
			(d: GuestDescriptor) => d.name === "setInterval",
		);
		const clearIntervalDesc = setup.guestFunctions?.find(
			(d: GuestDescriptor) => d.name === "clearInterval",
		);
		let id = -1;
		const cb = stubCallable(() => {
			(clearIntervalDesc?.handler as unknown as (id: number) => void)(id);
		});
		id = (
			setIntervalDesc?.handler as unknown as (
				cb: Callable,
				delay: number,
			) => number
		)(cb, 0);
		await vi.advanceTimersByTimeAsync(5);
		expect(cb.invocations).toBe(1);
		expect(cb.disposed).toBe(true);
		// Further ticks must be no-ops; no second invocation.
		await vi.advanceTimersByTimeAsync(50);
		expect(cb.invocations).toBe(1);
	});

	it("clamps negative/NaN/overflow delays to 0 instead of warning", async () => {
		const ctx = recordingCtx();
		const setup = worker(ctx);
		const setTimeoutDesc = setup.guestFunctions?.find(
			(d: GuestDescriptor) => d.name === "setTimeout",
		);
		const handler = setTimeoutDesc?.handler as unknown as (
			cb: Callable,
			delay: number,
		) => number;
		const cb = stubCallable();
		handler(cb, Number.NaN);
		handler(cb, -5);
		handler(cb, 2 ** 32);
		vi.advanceTimersByTime(1);
		expect(cb.invocations).toBe(3);
	});
});
