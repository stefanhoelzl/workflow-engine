import { describe, expect, it, vi } from "vitest";
import type {
	Plugin,
	PluginDescriptor,
	PluginSetup,
	RunInput,
	RunResult,
	SandboxContext,
} from "./plugin.js";
import {
	collectGuestFunctions,
	type DanglingFrameWarning,
	type FrameTracker,
	type GlobalBinder,
	loadPluginModules,
	type ModuleLoader,
	runOnBeforeRunStarted,
	runOnRunFinished,
	runPhasePrivateDelete,
	runPhaseSourceEval,
	runPhaseWorker,
	type SourceEvaluator,
	truncateFinalRefStack,
} from "./plugin-runtime.js";

const noopCtx: SandboxContext = {
	emit() {
		/* no-op */
	},
	request(_prefix, _name, _extra, fn) {
		return fn();
	},
};

function descriptor(
	name: string,
	opts: Partial<Pick<PluginDescriptor, "dependsOn" | "config">> = {},
): PluginDescriptor {
	const d: PluginDescriptor = {
		name,
		source: `export default () => ({ name: "${name}" });`,
	};
	if (opts.dependsOn !== undefined) {
		return { ...d, dependsOn: opts.dependsOn };
	}
	if (opts.config !== undefined) {
		return { ...d, config: opts.config };
	}
	return d;
}

function registryLoader(registry: Record<string, Plugin>): ModuleLoader {
	return (d) => {
		const p = registry[d.name];
		if (!p) {
			throw new Error(`no module for "${d.name}"`);
		}
		return p;
	};
}

describe("loadPluginModules", () => {
	it("resolves each descriptor via the supplied loader in order", async () => {
		const calls: string[] = [];
		const registry: Record<string, Plugin> = {
			a: { name: "a", worker: () => undefined },
			b: { name: "b", worker: () => undefined },
		};
		const loader: ModuleLoader = (d) => {
			calls.push(d.name);
			return registry[d.name] as Plugin;
		};
		const loaded = await loadPluginModules(
			[descriptor("a"), descriptor("b")],
			loader,
		);
		expect(calls).toEqual(["a", "b"]);
		expect(loaded.map((l) => l.descriptor.name)).toEqual(["a", "b"]);
	});

	it("annotates loader throws with the offending plugin name", async () => {
		const loader: ModuleLoader = (d) => {
			throw new Error(`boom for ${d.name}`);
		};
		await expect(
			loadPluginModules([descriptor("broken")], loader),
		).rejects.toThrow(/plugin "broken" failed during load: boom for broken/);
	});

	it("rejects when the loaded plugin's name disagrees with the descriptor", async () => {
		const mismatched: Plugin = { name: "other", worker: () => undefined };
		const loader: ModuleLoader = () => mismatched;
		await expect(loadPluginModules([descriptor("a")], loader)).rejects.toThrow(
			/plugin "a" module exported a plugin with mismatching name "other"/,
		);
	});
});

describe("runPhaseWorker", () => {
	it("invokes plugin.worker() in the given order and threads exports through deps", async () => {
		const calls: string[] = [];
		const firstExports = { token: "from-first" };
		const first: Plugin = {
			name: "first",
			worker: () => {
				calls.push("first");
				return { exports: firstExports };
			},
		};
		let secondDeps: unknown;
		const second: Plugin = {
			name: "second",
			dependsOn: ["first"],
			worker: (_ctx, deps) => {
				calls.push("second");
				secondDeps = deps;
				return;
			},
		};
		const loaded = await loadPluginModules(
			[descriptor("first"), descriptor("second", { dependsOn: ["first"] })],
			registryLoader({ first, second }),
		);
		const result = await runPhaseWorker(loaded, noopCtx);
		expect(calls).toEqual(["first", "second"]);
		expect(result.order).toEqual(["first", "second"]);
		expect(secondDeps).toEqual({ first: firstExports });
	});

	it("annotates a plugin.worker() throw with the plugin name", async () => {
		const broken: Plugin = {
			name: "broken",
			worker: () => {
				throw new Error("worker boom");
			},
		};
		const loaded = await loadPluginModules(
			[descriptor("broken")],
			registryLoader({ broken }),
		);
		await expect(runPhaseWorker(loaded, noopCtx)).rejects.toThrow(
			/plugin "broken" failed during worker: worker boom/,
		);
	});

	it("annotates an async plugin.worker() rejection with the plugin name", async () => {
		const broken: Plugin = {
			name: "async-broken",
			worker: () => Promise.reject(new Error("async boom")),
		};
		const loaded = await loadPluginModules(
			[descriptor("async-broken")],
			registryLoader({ "async-broken": broken }),
		);
		await expect(runPhaseWorker(loaded, noopCtx)).rejects.toThrow(
			/plugin "async-broken" failed during worker: async boom/,
		);
	});

	it("passes descriptor.config through to plugin.worker()", async () => {
		let received: unknown;
		const plugin: Plugin = {
			name: "cfg",
			worker: (_ctx, _deps, config) => {
				received = config;
				return;
			},
		};
		const loaded = await loadPluginModules(
			[descriptor("cfg", { config: { tag: "hello" } })],
			registryLoader({ cfg: plugin }),
		);
		await runPhaseWorker(loaded, noopCtx);
		expect(received).toEqual({ tag: "hello" });
	});
});

function phase1From(
	order: readonly string[],
	setupsByName: Record<string, PluginSetup>,
) {
	const setups = new Map<string, PluginSetup>();
	for (const n of order) {
		const s = setupsByName[n];
		if (s !== undefined) {
			setups.set(n, s);
		}
	}
	return { setups, order };
}

describe("runPhaseSourceEval", () => {
	it("evaluates each plugin's source in the phase-1 order with a <plugin:name> filename", () => {
		const evalCalls: { source: string; filename: string }[] = [];
		const evaluator: SourceEvaluator = {
			eval(source, filename) {
				evalCalls.push({ source, filename });
			},
		};
		runPhaseSourceEval(
			phase1From(["a", "b"], {
				a: { source: "/* a */" },
				b: { source: "/* b */" },
			}),
			evaluator,
		);
		expect(evalCalls).toEqual([
			{ source: "/* a */", filename: "<plugin:a>" },
			{ source: "/* b */", filename: "<plugin:b>" },
		]);
	});

	it("skips plugins whose PluginSetup has no source", () => {
		const evaluator: SourceEvaluator = { eval: vi.fn() };
		runPhaseSourceEval(
			phase1From(["a", "b"], { a: {}, b: { source: "/* b */" } }),
			evaluator,
		);
		expect(evaluator.eval).toHaveBeenCalledTimes(1);
		expect(evaluator.eval).toHaveBeenCalledWith("/* b */", "<plugin:b>");
	});

	it("annotates source-eval throws with the offending plugin name", () => {
		const evaluator: SourceEvaluator = {
			eval(_source, filename) {
				throw new Error(`bad in ${filename}`);
			},
		};
		expect(() =>
			runPhaseSourceEval(
				phase1From(["boom"], { boom: { source: "/* bad */" } }),
				evaluator,
			),
		).toThrow(/plugin "boom" failed during source-eval: bad in <plugin:boom>/);
	});
});

describe("runPhasePrivateDelete", () => {
	it("deletes every guest function without public:true from the global", () => {
		const deletes: string[] = [];
		const binder: GlobalBinder = {
			delete(name) {
				deletes.push(name);
			},
		};
		const phase1 = phase1From(["a"], {
			a: {
				guestFunctions: [
					{
						name: "__private",
						args: [],
						result: { kind: "void" },
						handler: () => undefined,
					},
					{
						name: "publicFn",
						args: [],
						result: { kind: "void" },
						handler: () => undefined,
						public: true,
					},
					{
						name: "__alsoPrivate",
						args: [],
						result: { kind: "void" },
						handler: () => undefined,
						public: false,
					},
				],
			},
		});
		const deleted = runPhasePrivateDelete(phase1, binder);
		expect(deletes).toEqual(["__private", "__alsoPrivate"]);
		expect(deleted).toEqual(["__private", "__alsoPrivate"]);
	});

	it("preserves phase-1 order across plugin boundaries", () => {
		const deletes: string[] = [];
		const binder: GlobalBinder = {
			delete(name) {
				deletes.push(name);
			},
		};
		const phase1 = phase1From(["first", "second"], {
			first: {
				guestFunctions: [
					{
						name: "__fromFirst",
						args: [],
						result: { kind: "void" },
						handler: () => undefined,
					},
				],
			},
			second: {
				guestFunctions: [
					{
						name: "__fromSecond",
						args: [],
						result: { kind: "void" },
						handler: () => undefined,
					},
				],
			},
		});
		runPhasePrivateDelete(phase1, binder);
		expect(deletes).toEqual(["__fromFirst", "__fromSecond"]);
	});

	it("is a no-op when no plugin registers guest functions", () => {
		const binder: GlobalBinder = { delete: vi.fn() };
		runPhasePrivateDelete(phase1From(["a"], { a: {} }), binder);
		expect(binder.delete).not.toHaveBeenCalled();
	});
});

function makeTracker(): FrameTracker & {
	push(): void;
	frames: number[];
} {
	const frames: number[] = [];
	let nextId = 1;
	return {
		frames,
		push() {
			frames.push(nextId++);
		},
		depth() {
			return frames.length;
		},
		truncateTo(d) {
			if (d < 0 || d > frames.length) {
				return 0;
			}
			const dropped = frames.length - d;
			frames.length = d;
			return dropped;
		},
	};
}

function setups(
	o: Record<string, PluginSetup>,
): ReadonlyMap<string, PluginSetup> {
	const m = new Map<string, PluginSetup>();
	for (const [k, v] of Object.entries(o)) {
		m.set(k, v);
	}
	return m;
}

const SAMPLE_RUN_INPUT: RunInput = { name: "handler", input: { x: 1 } };
const OK_RESULT: RunResult = { ok: true, output: { y: 2 } };
const ERR_RESULT: RunResult = { ok: false, error: new Error("boom") };

describe("runOnBeforeRunStarted", () => {
	it("invokes hooks in topo order and leaves frames pushed by truthy-returning hooks", () => {
		const tracker = makeTracker();
		const order = ["a", "b"];
		const map = setups({
			a: {
				onBeforeRunStarted: () => {
					tracker.push();
					return true;
				},
			},
			b: {
				onBeforeRunStarted: () => {
					tracker.push();
					return true;
				},
			},
		});
		runOnBeforeRunStarted({
			setups: map,
			order,
			runInput: SAMPLE_RUN_INPUT,
			tracker,
		});
		expect(tracker.depth()).toBe(2);
	});

	it("truncates frames pushed by a hook that returns falsy/void and warns per dropped frame", () => {
		const tracker = makeTracker();
		const warns: DanglingFrameWarning[] = [];
		const map = setups({
			misbehaving: {
				onBeforeRunStarted: () => {
					tracker.push();
					tracker.push();
					// intentionally return nothing
				},
			},
		});
		runOnBeforeRunStarted({
			setups: map,
			order: ["misbehaving"],
			runInput: SAMPLE_RUN_INPUT,
			tracker,
			warn: (w) => warns.push(w),
		});
		expect(tracker.depth()).toBe(0);
		expect(warns).toEqual([
			{ phase: "onBeforeRunStarted", plugin: "misbehaving", dropped: 2 },
		]);
	});

	it("truncates partial frames on a hook throw and annotates the plugin name", () => {
		const tracker = makeTracker();
		const map = setups({
			blown: {
				onBeforeRunStarted: () => {
					tracker.push();
					throw new Error("oops");
				},
			},
		});
		expect(() =>
			runOnBeforeRunStarted({
				setups: map,
				order: ["blown"],
				runInput: SAMPLE_RUN_INPUT,
				tracker,
			}),
		).toThrow(/plugin "blown" threw in onBeforeRunStarted: oops/);
		expect(tracker.depth()).toBe(0);
	});

	it("passes the run input through to every hook", () => {
		const tracker = makeTracker();
		const received: RunInput[] = [];
		const map = setups({
			a: {
				onBeforeRunStarted: (ri) => {
					received.push(ri);
				},
			},
			b: {
				onBeforeRunStarted: (ri) => {
					received.push(ri);
				},
			},
		});
		runOnBeforeRunStarted({
			setups: map,
			order: ["a", "b"],
			runInput: SAMPLE_RUN_INPUT,
			tracker,
		});
		expect(received).toEqual([SAMPLE_RUN_INPUT, SAMPLE_RUN_INPUT]);
	});
});

describe("runOnRunFinished", () => {
	it("invokes hooks in REVERSE topo order", () => {
		const calls: string[] = [];
		const map = setups({
			a: {
				onRunFinished: () => {
					calls.push("a");
				},
			},
			b: {
				onRunFinished: () => {
					calls.push("b");
				},
			},
			c: {
				onRunFinished: () => {
					calls.push("c");
				},
			},
		});
		runOnRunFinished({
			setups: map,
			order: ["a", "b", "c"],
			result: OK_RESULT,
			runInput: SAMPLE_RUN_INPUT,
		});
		expect(calls).toEqual(["c", "b", "a"]);
	});

	it("passes the RunResult and RunInput to every hook", () => {
		const received: { result: RunResult; input: RunInput }[] = [];
		const map = setups({
			a: {
				onRunFinished: (r, i) => {
					received.push({ result: r, input: i });
				},
			},
		});
		runOnRunFinished({
			setups: map,
			order: ["a"],
			result: ERR_RESULT,
			runInput: SAMPLE_RUN_INPUT,
		});
		expect(received).toEqual([{ result: ERR_RESULT, input: SAMPLE_RUN_INPUT }]);
	});

	it("continues cleanup after a hook throws and returns the collected errors", () => {
		const calls: string[] = [];
		const warns: DanglingFrameWarning[] = [];
		const map = setups({
			a: {
				onRunFinished: () => {
					calls.push("a");
				},
			},
			b: {
				onRunFinished: () => {
					throw new Error("b-fail");
				},
			},
			c: {
				onRunFinished: () => {
					calls.push("c");
				},
			},
		});
		const errs = runOnRunFinished({
			setups: map,
			order: ["a", "b", "c"],
			result: OK_RESULT,
			runInput: SAMPLE_RUN_INPUT,
			warn: (w) => warns.push(w),
		});
		expect(calls).toEqual(["c", "a"]);
		expect(errs.length).toBe(1);
		expect(errs[0]?.message).toMatch(
			/plugin "b" threw in onRunFinished: b-fail/,
		);
		expect(warns[0]?.plugin).toBe("b");
	});
});

describe("truncateFinalRefStack", () => {
	it("drops all remaining frames and warns when any are dropped", () => {
		const tracker = makeTracker();
		tracker.push();
		tracker.push();
		tracker.push();
		const warns: DanglingFrameWarning[] = [];
		const dropped = truncateFinalRefStack(tracker, (w) => warns.push(w));
		expect(dropped).toBe(3);
		expect(tracker.depth()).toBe(0);
		expect(warns).toEqual([{ phase: "final", dropped: 3 }]);
	});

	it("is silent when nothing needs truncation", () => {
		const tracker = makeTracker();
		const warn = vi.fn();
		const dropped = truncateFinalRefStack(tracker, warn);
		expect(dropped).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("runOnBeforeRunStarted + runOnRunFinished together", () => {
	it("preserves a frame opened by onBeforeRunStarted so onRunFinished can close it", () => {
		const tracker = makeTracker();
		const events: string[] = [];
		const map = setups({
			trigger: {
				onBeforeRunStarted: () => {
					events.push(`open@${tracker.depth()}`);
					tracker.push();
					return true;
				},
				onRunFinished: () => {
					// At this point the frame opened in onBeforeRunStarted is still
					// present; a real plugin would emit closesFrame here and
					// truncate via ctx / bridge.popRef. For this unit test we
					// assert only that depth is 1 (the preserved frame).
					events.push(`close@${tracker.depth()}`);
					tracker.truncateTo(tracker.depth() - 1);
				},
			},
		});
		runOnBeforeRunStarted({
			setups: map,
			order: ["trigger"],
			runInput: SAMPLE_RUN_INPUT,
			tracker,
		});
		expect(tracker.depth()).toBe(1);
		runOnRunFinished({
			setups: map,
			order: ["trigger"],
			result: OK_RESULT,
			runInput: SAMPLE_RUN_INPUT,
		});
		expect(tracker.depth()).toBe(0);
		expect(events).toEqual(["open@0", "close@1"]);
	});
});

describe("collectGuestFunctions", () => {
	it("flattens guest function descriptors in phase-1 order with plugin attribution", () => {
		const phase1 = phase1From(["a", "b"], {
			a: {
				guestFunctions: [
					{
						name: "f1",
						args: [],
						result: { kind: "void" },
						handler: () => undefined,
					},
				],
			},
			b: {
				guestFunctions: [
					{
						name: "f2",
						args: [],
						result: { kind: "void" },
						handler: () => undefined,
					},
				],
			},
		});
		const flat = collectGuestFunctions(phase1);
		expect(flat.map((e) => [e.pluginName, e.descriptor.name])).toEqual([
			["a", "f1"],
			["b", "f2"],
		]);
	});
});
