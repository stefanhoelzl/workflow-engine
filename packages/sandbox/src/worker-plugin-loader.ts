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
 * An appended `//# sourceURL=sandbox-plugin:<name>` comment names the module
 * `sandbox-plugin:<name>` in V8 stack traces. Without it, every frame's
 * script name is the full data: URL — i.e. the entire base64-encoded bundle,
 * repeated per frame — which once inflated a 30-byte fetch error into a
 * multi-MB `system.error` payload. `import.meta.url` and the module-cache
 * key remain the data: URL; only the displayed source name changes.
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
	// The leading \n guarantees the sourceURL comment is the script's final
	// line (the only position V8 honors) even if the bundle ends in a `//`
	// line comment.
	const source = `${descriptor.workerSource}\n//# sourceURL=sandbox-plugin:${descriptor.name}`;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
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
