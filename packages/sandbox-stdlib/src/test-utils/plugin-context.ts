import type { PluginContext } from "@workflow-engine/sandbox";

// A `PluginContext` whose `emit` is a no-op and whose `request` simply
// invokes `fn()` (no open/close paired events). Each call returns a fresh
// instance so tests retain isolation; never share a single instance across
// tests.
function createNoopPluginContext(): PluginContext {
	return {
		emit() {
			return 0 as never;
		},
		request(_prefix, _options, fn) {
			return fn();
		},
		callHost() {
			return Promise.reject(new Error("host-call unavailable in test context"));
		},
	};
}

export { createNoopPluginContext };
