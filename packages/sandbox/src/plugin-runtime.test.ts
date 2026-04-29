import { describe, expect, it, vi } from "vitest";
import type {
	Plugin,
	PluginContext,
	PluginDescriptor,
	PluginSetup,
	RunInput,
	RunResult,
} from "./plugin.js";
import {
	collectGuestFunctions,
	type DanglingFrameWarning,
	type GlobalBinder,
	loadPluginModules,
	type ModuleLoader,
	runOnBeforeRunStarted,
	runOnPost,
	runOnRunFinished,
	runPhasePrivateDelete,
	runPhaseSourceEval,
	runPhaseWorker,
	type SourceEvaluator,
} from "./plugin-runtime.js";
import type { WorkerToMain } from "./protocol.js";

const noopCtx: PluginContext = {
	// Cast to `never` matches the boundary cast in `createPluginContext` —
	// `emit` has a conditional return type that narrows per call site.
	emit() {
		return 0 as never;
	},
	request(_prefix, _options, fn) {
		return fn();
	},
};

function descriptor(
	name: string,
	opts: Partial<Pick<PluginDescriptor, "dependsOn" | "config">> = {},
): PluginDescriptor {
	const d: PluginDescriptor = {
		name,
		workerSource: `export default () => ({ name: "${name}" });`,
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
	function desc(name: string, guestSource?: string): PluginDescriptor {
		const d: PluginDescriptor = {
			name,
			workerSource: "/* worker */",
		};
		return guestSource === undefined ? d : { ...d, guestSource };
	}

	it("evaluates each plugin's guestSource in the phase-1 order with a <plugin:name> filename", () => {
		const evalCalls: { source: string; filename: string }[] = [];
		const evaluator: SourceEvaluator = {
			eval(source, filename) {
				evalCalls.push({ source, filename });
			},
		};
		runPhaseSourceEval(
			phase1From(["a", "b"], { a: {}, b: {} }),
			[desc("a", "/* a */"), desc("b", "/* b */")],
			evaluator,
		);
		expect(evalCalls).toEqual([
			{ source: "/* a */", filename: "<plugin:a>" },
			{ source: "/* b */", filename: "<plugin:b>" },
		]);
	});

	it("skips plugins whose descriptor has no guestSource", () => {
		const evaluator: SourceEvaluator = { eval: vi.fn() };
		runPhaseSourceEval(
			phase1From(["a", "b"], { a: {}, b: {} }),
			[desc("a"), desc("b", "/* b */")],
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
				phase1From(["boom"], { boom: {} }),
				[desc("boom", "/* bad */")],
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
	it("invokes hooks in topo order", () => {
		const order = ["a", "b"];
		const calls: string[] = [];
		const map = setups({
			a: {
				onBeforeRunStarted: () => {
					calls.push("a");
					return true;
				},
			},
			b: {
				onBeforeRunStarted: () => {
					calls.push("b");
					return true;
				},
			},
		});
		runOnBeforeRunStarted({
			setups: map,
			order,
			runInput: SAMPLE_RUN_INPUT,
		});
		expect(calls).toEqual(["a", "b"]);
	});

	it("annotates a thrown hook error with the plugin name and rethrows", () => {
		const map = setups({
			blown: {
				onBeforeRunStarted: () => {
					throw new Error("oops");
				},
			},
		});
		expect(() =>
			runOnBeforeRunStarted({
				setups: map,
				order: ["blown"],
				runInput: SAMPLE_RUN_INPUT,
			}),
		).toThrow(/plugin "blown" threw in onBeforeRunStarted: oops/);
	});

	it("passes the run input through to every hook", () => {
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

describe("runOnBeforeRunStarted + runOnRunFinished together", () => {
	it("invokes both hooks in the right phases for a trigger-shaped plugin", () => {
		const events: string[] = [];
		const map = setups({
			trigger: {
				onBeforeRunStarted: () => {
					events.push("open");
					return true;
				},
				onRunFinished: () => {
					events.push("close");
				},
			},
		});
		runOnBeforeRunStarted({
			setups: map,
			order: ["trigger"],
			runInput: SAMPLE_RUN_INPUT,
		});
		runOnRunFinished({
			setups: map,
			order: ["trigger"],
			result: OK_RESULT,
			runInput: SAMPLE_RUN_INPUT,
		});
		expect(events).toEqual(["open", "close"]);
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

describe("runOnPost", () => {
	const EVENT_MSG: WorkerToMain = {
		type: "event",
		event: {
			kind: "action.request",
			at: "2026-04-24T00:00:00.000Z",
			ts: 1000,
			name: "foo",
			input: "hello world",
			type: { open: 7 },
		},
	};
	const READY_MSG: WorkerToMain = { type: "ready" };
	const DONE_MSG: WorkerToMain = {
		type: "done",
		payload: { ok: true, result: "hello world" },
	};
	const LOG_MSG: WorkerToMain = {
		type: "log",
		level: "info",
		message: "hello world",
	};

	it("passes the message through unchanged when no plugin has onPost", () => {
		const map = setups({ a: {}, b: {} });
		const result = runOnPost({
			setups: map,
			order: ["a", "b"],
			msg: EVENT_MSG,
		});
		expect(result.msg).toBe(EVENT_MSG);
		expect(result.errors).toHaveLength(0);
	});

	it("chains transforms through hooks in topological order", () => {
		const map = setups({
			a: {
				onPost: (m) => {
					if (m.type === "event") {
						return {
							...m,
							event: { ...m.event, input: "step-a" },
						};
					}
					return m;
				},
			},
			b: {
				onPost: (m) => {
					if (m.type === "event") {
						return {
							...m,
							event: { ...m.event, input: `${m.event.input}-step-b` },
						};
					}
					return m;
				},
			},
		});
		const result = runOnPost({
			setups: map,
			order: ["a", "b"],
			msg: EVENT_MSG,
		});
		expect(result.msg).toMatchObject({
			type: "event",
			event: { input: "step-a-step-b" },
		});
		expect(result.errors).toHaveLength(0);
	});

	it("skips plugins without onPost", () => {
		const map = setups({
			a: {},
			b: {
				onPost: (m) => {
					if (m.type === "log") {
						return { ...m, message: "touched" };
					}
					return m;
				},
			},
		});
		const result = runOnPost({
			setups: map,
			order: ["a", "b"],
			msg: LOG_MSG,
		});
		expect(result.msg).toMatchObject({ type: "log", message: "touched" });
	});

	it("continues the chain when a hook throws, recording the error", () => {
		const map = setups({
			a: {
				onPost: () => {
					throw new Error("boom");
				},
			},
			b: {
				onPost: (m) => {
					if (m.type === "done") {
						return { ...m, payload: { ok: true, result: "from-b" } };
					}
					return m;
				},
			},
		});
		const result = runOnPost({
			setups: map,
			order: ["a", "b"],
			msg: DONE_MSG,
		});
		expect(result.msg).toMatchObject({
			type: "done",
			payload: { ok: true, result: "from-b" },
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toMatch(
			/plugin "a" threw in onPost: boom/,
		);
		expect(
			(result.errors[0] as Error & { pluginName?: string }).pluginName,
		).toBe("a");
	});

	it("applies to every WorkerToMain kind (ready, event, done, log)", () => {
		const map = setups({
			touch: {
				onPost: (m) => {
					if (m.type === "ready") {
						return m;
					}
					if (m.type === "event") {
						return { ...m, event: { ...m.event, input: "touched" } };
					}
					if (m.type === "done") {
						return { ...m, payload: { ok: true, result: "touched" } };
					}
					if (m.type === "log") {
						return { ...m, message: "touched" };
					}
					return m;
				},
			},
		});
		expect(
			runOnPost({ setups: map, order: ["touch"], msg: READY_MSG }).msg,
		).toEqual(READY_MSG);
		expect(
			runOnPost({ setups: map, order: ["touch"], msg: EVENT_MSG }).msg,
		).toMatchObject({ type: "event", event: { input: "touched" } });
		expect(
			runOnPost({ setups: map, order: ["touch"], msg: DONE_MSG }).msg,
		).toMatchObject({ type: "done", payload: { result: "touched" } });
		expect(
			runOnPost({ setups: map, order: ["touch"], msg: LOG_MSG }).msg,
		).toMatchObject({ type: "log", message: "touched" });
	});

	it("cannot observe messages emitted before its own registration window", () => {
		// Sanity: runOnPost is stateless across calls; a plugin's onPost
		// does not see prior calls' data unless the plugin itself retained it.
		const seen: unknown[] = [];
		const map = setups({
			a: {
				onPost: (m) => {
					seen.push(m);
					return m;
				},
			},
		});
		runOnPost({ setups: map, order: ["a"], msg: READY_MSG });
		runOnPost({ setups: map, order: ["a"], msg: EVENT_MSG });
		expect(seen).toEqual([READY_MSG, EVENT_MSG]);
	});
});
