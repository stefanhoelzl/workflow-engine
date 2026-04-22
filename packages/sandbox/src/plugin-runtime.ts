import type {
	DepsMap,
	GuestFunctionDescription,
	Plugin,
	PluginDescriptor,
	PluginSetup,
	RunInput,
	RunResult,
	SandboxContext,
	SerializableConfig,
} from "./plugin.js";
import type { ArgSpec, ResultSpec } from "./plugin-types.js";

/**
 * Phased init pipeline.
 *
 * Phase 0: module load. The caller resolves each descriptor's `source`
 *          to a Plugin value. In production this is a `data:` URI
 *          dynamic import of the tree-shaken bundle; in tests it's a
 *          direct registry.
 * Phase 1: plugin.worker(ctx, deps, config). Plugins may read exports of
 *          their declared `dependsOn` peers via `deps`.
 * Phase 2: plugin source evaluation. Each plugin's PluginSetup.source is
 *          evaluated in topo order. Guest source captures any private
 *          descriptors (e.g. `const capture = globalThis.__x; delete globalThis.__x;`).
 * Phase 3: private-descriptor auto-deletion. For every registered guest
 *          function with `public !== true`, `delete globalThis[name]` — so
 *          that plugins which forgot to self-delete still end up structurally
 *          private before user source runs.
 * Phase 4: user source evaluation (handled by the caller post-pipeline).
 *
 * All phases below are synchronous given their PluginSetup inputs. Phase 1 is
 * async because plugin.worker may itself be async (e.g. dynamic imports inside
 * the worker setup). Errors bubble up annotated with the offending plugin
 * name so init-error posts are actionable.
 */

interface LoadedPlugin {
	readonly descriptor: PluginDescriptor;
	readonly plugin: Plugin;
}

type ModuleLoader = (descriptor: PluginDescriptor) => Promise<Plugin> | Plugin;

/**
 * Phase 0 — resolve each descriptor's Plugin value via the caller-supplied
 * ModuleLoader. In production the loader evaluates `descriptor.source` via
 * `data:` URI dynamic import and picks its default export (the worker
 * function); in tests it's a direct registry lookup.
 */
async function loadPluginModules(
	descriptors: readonly PluginDescriptor[],
	loader: ModuleLoader,
): Promise<readonly LoadedPlugin[]> {
	// Module loads are independent of each other — the input array has already
	// been topo-sorted and name-validated by serializePluginDescriptors.
	// Parallelise them and preserve input order via indexed Promise.all.
	const resolutions = descriptors.map(async (descriptor) => {
		try {
			const plugin = await loader(descriptor);
			return { descriptor, plugin };
		} catch (err) {
			throw annotatePluginError(descriptor.name, "load", err);
		}
	});
	const loaded = await Promise.all(resolutions);
	for (const { descriptor, plugin } of loaded) {
		if (plugin.name !== descriptor.name) {
			throw new Error(
				`plugin "${descriptor.name}" module exported a plugin with mismatching name "${plugin.name}"`,
			);
		}
	}
	return loaded;
}

interface Phase1Result {
	readonly setups: ReadonlyMap<string, PluginSetup>;
	/** Order in which plugins were invoked — used for Phase-2 source-eval order. */
	readonly order: readonly string[];
}

/**
 * Phase 1 — run every plugin.worker() in topo order. Each plugin receives
 * the sandbox context, a deps map containing the exports of its declared
 * dependencies, and its configured descriptor.config.
 *
 * Assumes `loaded` is already topo-sorted. Deps are accumulated as each
 * plugin runs — a plugin's entry in the returned map appears only after its
 * worker() completes, so any dependent that comes later sees it.
 *
 * If a plugin's worker() throws (sync or async), init aborts with an error
 * annotated by plugin name; the partial setup map is discarded.
 */
async function runPhaseWorker(
	loaded: readonly LoadedPlugin[],
	ctx: SandboxContext,
): Promise<Phase1Result> {
	const setups = new Map<string, PluginSetup>();
	const order: string[] = [];
	const exportsByName = new Map<string, Record<string, unknown>>();
	for (const { descriptor, plugin } of loaded) {
		const deps: DepsMap = {};
		for (const depName of descriptor.dependsOn ?? []) {
			const depExports = exportsByName.get(depName);
			if (depExports !== undefined) {
				deps[depName] = depExports;
			}
		}
		const config = descriptor.config as SerializableConfig;
		let setup: PluginSetup | undefined;
		try {
			// biome-ignore lint/performance/noAwaitInLoops: phase-1 must be sequential — each plugin's deps come from preceding plugins' exports
			const raw = await plugin.worker(ctx, deps, config);
			setup = raw ?? undefined;
		} catch (err) {
			throw annotatePluginError(descriptor.name, "worker", err);
		}
		if (setup !== undefined) {
			setups.set(descriptor.name, setup);
			if (setup.exports !== undefined) {
				exportsByName.set(descriptor.name, setup.exports);
			}
		}
		order.push(descriptor.name);
	}
	return { setups, order };
}

interface SourceEvaluator {
	eval(source: string, filename: string): void;
}

/**
 * Phase 2 — evaluate each plugin's PluginSetup.source in the given order.
 * Plugins without a `source` are skipped. A thrown evaluation is annotated
 * with the offending plugin name before re-throwing. The evaluator is
 * caller-supplied so this phase is VM-agnostic and unit-testable.
 *
 * The filename passed to the evaluator is stable per plugin
 * (`<plugin:${name}>`) so stack traces point to the origin plugin.
 */
function runPhaseSourceEval(
	phase1: Phase1Result,
	evaluator: SourceEvaluator,
): void {
	for (const name of phase1.order) {
		const setup = phase1.setups.get(name);
		if (setup?.source === undefined) {
			continue;
		}
		try {
			evaluator.eval(setup.source, `<plugin:${name}>`);
		} catch (err) {
			throw annotatePluginError(name, "source-eval", err);
		}
	}
}

interface GlobalBinder {
	delete(name: string): void;
}

/**
 * Phase 3 — delete every guest function descriptor whose `public !== true`
 * from the VM's global object. This runs AFTER Phase 2 so plugin source has
 * had a chance to capture (`const x = globalThis.__x`) bindings before they
 * are removed.
 *
 * Descriptors with `public: true` are left in place. Plugins that never
 * register guestFunctions contribute nothing here. The deletion is best-effort
 * (the binder decides whether delete-of-a-missing-prop is a no-op or a throw;
 * the production QuickJS-backed binder is a no-op in that case).
 */
function runPhasePrivateDelete(
	phase1: Phase1Result,
	binder: GlobalBinder,
): readonly string[] {
	const deleted: string[] = [];
	for (const name of phase1.order) {
		const setup = phase1.setups.get(name);
		if (!setup?.guestFunctions) {
			continue;
		}
		for (const gf of setup.guestFunctions) {
			if (gf.public === true) {
				continue;
			}
			binder.delete(gf.name);
			deleted.push(gf.name);
		}
	}
	return deleted;
}

/**
 * Collects guest functions in the order they should be installed on the VM
 * global. Exposed so the worker (or tests) can iterate the flat list without
 * re-walking the setup map. Order matches Phase-2 source-eval order (each
 * plugin's guestFunctions are contributed in descriptor-declaration order).
 */
function collectGuestFunctions(phase1: Phase1Result): readonly {
	readonly pluginName: string;
	readonly descriptor: GuestFunctionDescription<
		readonly ArgSpec<unknown>[],
		ResultSpec<unknown>
	>;
}[] {
	const out: {
		pluginName: string;
		descriptor: GuestFunctionDescription<
			readonly ArgSpec<unknown>[],
			ResultSpec<unknown>
		>;
	}[] = [];
	for (const name of phase1.order) {
		const setup = phase1.setups.get(name);
		if (!setup?.guestFunctions) {
			continue;
		}
		for (const gf of setup.guestFunctions) {
			out.push({ pluginName: name, descriptor: gf });
		}
	}
	return out;
}

/**
 * Abstracts the Bridge's refStack for testability. The production
 * implementation delegates to `Bridge.refStackDepth()` and
 * `Bridge.truncateRefStackTo()`; tests use an in-memory array.
 *
 * Frame tracking drives the auto-balance semantics of onBeforeRunStarted:
 * hooks that return falsy have all frames they pushed rewound; hooks that
 * return truthy keep their frames open for the run body + onRunFinished.
 */
interface FrameTracker {
	depth(): number;
	truncateTo(depth: number): number;
}

interface DanglingFrameWarning {
	readonly phase: "onBeforeRunStarted" | "run-body" | "onRunFinished" | "final";
	readonly plugin?: string;
	readonly dropped: number;
}

type WarnFn = (warning: DanglingFrameWarning) => void;

/**
 * Runs every plugin's onBeforeRunStarted hook in topo order. For each hook:
 *  1. Record the refStack depth BEFORE invocation.
 *  2. Call the hook synchronously.
 *  3. If the hook returns truthy, leave its pushed frames in place — the
 *     plugin wants to wrap the run body (e.g. trigger plugin's
 *     trigger.request frame stays open until onRunFinished emits
 *     trigger.response/error).
 *  4. If the hook returns falsy/void, truncate back to the pre-hook depth —
 *     the plugin auto-balanced, or forgot to close a frame it opened.
 *     Emit a warning if any frames were truncated so dangling pushes are
 *     visible in logs but do not leak into the run body.
 *
 * If a hook throws, the error is annotated with the plugin name and rethrown.
 * The caller is responsible for running onRunFinished in its own catch block
 * so that cleanup still happens.
 */
interface OnBeforeRunStartedArgs {
	readonly setups: ReadonlyMap<string, PluginSetup>;
	readonly order: readonly string[];
	readonly runInput: RunInput;
	readonly tracker: FrameTracker;
	readonly warn?: WarnFn;
}

function runOnBeforeRunStarted(args: OnBeforeRunStartedArgs): void {
	const { setups, order, runInput, tracker, warn } = args;
	for (const name of order) {
		const setup = setups.get(name);
		if (!setup?.onBeforeRunStarted) {
			continue;
		}
		const before = tracker.depth();
		let keep: boolean;
		try {
			keep = setup.onBeforeRunStarted(runInput) === true;
		} catch (err) {
			// Truncate any partial frames so the error path doesn't leak them.
			tracker.truncateTo(before);
			throw annotateLifecycleError(name, "onBeforeRunStarted", err);
		}
		if (!keep) {
			const dropped = tracker.truncateTo(before);
			if (dropped > 0 && warn) {
				warn({ phase: "onBeforeRunStarted", plugin: name, dropped });
			}
		}
	}
}

/**
 * Runs every plugin's onRunFinished hook in REVERSE topo order. refStack
 * frames opened during onBeforeRunStarted (by hooks that returned truthy)
 * are still present — this is load-bearing for plugins like `trigger` which
 * emit trigger.response/error via `closesFrame: true`, matching the
 * trigger.request pushed in onBeforeRunStarted.
 *
 * Hook throws are caught per-plugin so that a single misbehaving plugin can
 * neither cancel cleanup for other plugins nor prevent the final-refStack
 * truncation. Each exception is surfaced via `warn` (if provided) so
 * operators see what went wrong, and then swallowed.
 */
interface OnRunFinishedArgs {
	readonly setups: ReadonlyMap<string, PluginSetup>;
	readonly order: readonly string[];
	readonly result: RunResult;
	readonly runInput: RunInput;
	readonly warn?: WarnFn;
}

function runOnRunFinished(args: OnRunFinishedArgs): readonly Error[] {
	const { setups, order, result, runInput, warn } = args;
	const errors: Error[] = [];
	for (let i = order.length - 1; i >= 0; i--) {
		const name = order[i];
		if (name === undefined) {
			continue;
		}
		const setup = setups.get(name);
		if (!setup?.onRunFinished) {
			continue;
		}
		try {
			setup.onRunFinished(result, runInput);
		} catch (err) {
			const annotated = annotateLifecycleError(name, "onRunFinished", err);
			errors.push(annotated);
			if (warn) {
				warn({ phase: "onRunFinished", plugin: name, dropped: 0 });
			}
		}
	}
	return errors;
}

/**
 * Final refStack cleanup — any frames still open after onRunFinished are
 * dangling (the run body emitted createsFrame without a matching closesFrame,
 * or a plugin's onBeforeRunStarted returned truthy but its onRunFinished
 * never emitted a closing event). Truncate to 0 and emit a warning so the
 * condition is audit-visible.
 *
 * A single final warning carries the total drop count; per-plugin
 * attribution isn't possible here because the refStack doesn't remember
 * which plugin pushed which frame.
 */
function truncateFinalRefStack(tracker: FrameTracker, warn?: WarnFn): number {
	const dropped = tracker.truncateTo(0);
	if (dropped > 0 && warn) {
		warn({ phase: "final", dropped });
	}
	return dropped;
}

function annotateLifecycleError(
	pluginName: string,
	hook: "onBeforeRunStarted" | "onRunFinished",
	err: unknown,
): Error {
	const msg = err instanceof Error ? err.message : String(err);
	const annotated = new Error(
		`plugin "${pluginName}" threw in ${hook}: ${msg}`,
	);
	if (err instanceof Error) {
		if (err.stack !== undefined) {
			annotated.stack = err.stack;
		}
		(annotated as Error & { cause?: unknown }).cause = err;
	}
	(annotated as Error & { pluginName?: string }).pluginName = pluginName;
	(annotated as Error & { hook?: string }).hook = hook;
	return annotated;
}

function annotatePluginError(
	pluginName: string,
	phase: "load" | "worker" | "source-eval",
	err: unknown,
): Error {
	const msg = err instanceof Error ? err.message : String(err);
	const annotated = new Error(
		`plugin "${pluginName}" failed during ${phase}: ${msg}`,
	);
	if (err instanceof Error) {
		if (err.stack !== undefined) {
			annotated.stack = err.stack;
		}
		(annotated as Error & { cause?: unknown }).cause = err;
	}
	(annotated as Error & { pluginName?: string }).pluginName = pluginName;
	(annotated as Error & { phase?: string }).phase = phase;
	return annotated;
}

export type {
	DanglingFrameWarning,
	FrameTracker,
	GlobalBinder,
	LoadedPlugin,
	ModuleLoader,
	OnBeforeRunStartedArgs,
	OnRunFinishedArgs,
	SourceEvaluator,
	WarnFn,
};
export {
	collectGuestFunctions,
	loadPluginModules,
	runOnBeforeRunStarted,
	runOnRunFinished,
	runPhasePrivateDelete,
	runPhaseSourceEval,
	runPhaseWorker,
	truncateFinalRefStack,
};
