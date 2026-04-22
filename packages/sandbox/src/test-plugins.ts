// Test-only fixture. The sandbox requires at least one plugin descriptor,
// so tests that want an effectively-empty composition use `NOOP_PLUGINS`.
// Not for production — runtime's sandbox-store composes the real plugin
// list with real configs.

import type { PluginDescriptor } from "./plugin.js";

const NOOP_PLUGIN_SOURCE = "export default () => ({});";

/** A single plugin whose `worker()` returns an empty PluginSetup. */
const NOOP_PLUGINS: readonly PluginDescriptor[] = Object.freeze([
	Object.freeze({ name: "noop", workerSource: NOOP_PLUGIN_SOURCE }),
]);

export { NOOP_PLUGIN_SOURCE, NOOP_PLUGINS };
