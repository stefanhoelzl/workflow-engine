import type { PluginSetup } from "../plugin.js";

/**
 * Inert base: registers no hooks so WASI computes real values and emits
 * no events. Hosts that want telemetry or override compose a separate
 * plugin (e.g. runtime's wasi-telemetry) whose `worker()` returns
 * `wasiHooks`. Configs must be JSON-serializable across postMessage, so
 * a live `setup` option isn't viable here — the separate-plugin pattern
 * is the replacement.
 */
const name = "wasi";

function worker(): PluginSetup | undefined {
	return;
}

export { name, worker };
