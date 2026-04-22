import type { Plugin, PluginDescriptor } from "./plugin.js";
import type { ModuleLoader } from "./plugin-runtime.js";

/**
 * Default ModuleLoader for worker-thread plugin resolution. Evaluates the
 * descriptor's `workerSource` via `data:` URI dynamic import — no filesystem
 * resolution, no package exports, no node_modules lookup. The module's
 * default export is the plugin's `worker(ctx, deps, config)` function;
 * `name` and `dependsOn` come from the descriptor (the source bundle
 * tree-shakes those consts away and the consumer passes them explicitly).
 *
 * Override via `__pluginLoaderOverride` for tests that want to supply a
 * live Plugin value without going through the bundling pipeline.
 */
const defaultPluginLoader: ModuleLoader = async (descriptor) => {
	const override = (globalThis as { __pluginLoaderOverride?: ModuleLoader })
		.__pluginLoaderOverride;
	if (override) {
		return override(descriptor);
	}
	return await loadPluginFromSource(descriptor);
};

async function loadPluginFromSource(
	descriptor: PluginDescriptor,
): Promise<Plugin> {
	const url = `data:text/javascript;base64,${Buffer.from(descriptor.workerSource).toString("base64")}`;
	const mod: unknown = await import(url);
	const modWithDefault = mod as { default?: unknown };
	const workerFn = modWithDefault.default;
	if (typeof workerFn !== "function") {
		throw new Error(
			`plugin "${descriptor.name}" workerSource module has no default-exported worker function`,
		);
	}
	return {
		name: descriptor.name,
		...(descriptor.dependsOn === undefined
			? {}
			: { dependsOn: descriptor.dependsOn }),
		worker: workerFn as Plugin["worker"],
	};
}

export { defaultPluginLoader, loadPluginFromSource };
