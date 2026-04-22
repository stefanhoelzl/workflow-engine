// Unit tests for the worker's default plugin loader (design §10).
// Verifies data: URI round-trip, descriptor → Plugin shape, and the
// `__pluginLoaderOverride` escape hatch used by higher-level tests.

import { afterEach, describe, expect, test } from "vitest";
import type { Plugin, PluginDescriptor } from "./plugin.js";
import type { ModuleLoader } from "./plugin-runtime.js";
import {
	defaultPluginLoader,
	loadPluginFromSource,
} from "./worker-plugin-loader.js";

function clearOverride(): void {
	(globalThis as { __pluginLoaderOverride?: unknown }).__pluginLoaderOverride =
		undefined;
}

describe("defaultPluginLoader — data: URI path", () => {
	afterEach(clearOverride);

	test("evaluates source, extracts default-exported worker, wraps as Plugin", async () => {
		const descriptor: PluginDescriptor = {
			name: "example",
			workerSource:
				"export default (ctx, deps, config) => ({ gotConfig: config });",
		};
		const plugin = await defaultPluginLoader(descriptor);
		expect(plugin.name).toBe("example");
		expect(plugin.dependsOn).toBeUndefined();
		expect(typeof plugin.worker).toBe("function");
		const setup = plugin.worker(
			{} as never,
			{} as never,
			{ greeting: "hi" } as never,
		);
		expect(setup).toEqual({ gotConfig: { greeting: "hi" } });
	});

	test("preserves dependsOn from descriptor on the wrapped Plugin", async () => {
		const descriptor: PluginDescriptor = {
			name: "child",
			dependsOn: ["parent"],
			workerSource: "export default () => ({});",
		};
		const plugin = await defaultPluginLoader(descriptor);
		expect(plugin.dependsOn).toEqual(["parent"]);
	});

	test("throws when the source module has no default export", async () => {
		const descriptor: PluginDescriptor = {
			name: "broken",
			workerSource: "export const notDefault = () => ({});",
		};
		await expect(defaultPluginLoader(descriptor)).rejects.toThrow(
			/"broken" workerSource module has no default-exported worker function/,
		);
	});

	test("throws when the default export is not a function", async () => {
		const descriptor: PluginDescriptor = {
			name: "weird",
			workerSource: `export default { hello: "world" };`,
		};
		await expect(defaultPluginLoader(descriptor)).rejects.toThrow(
			/"weird" workerSource module has no default-exported worker function/,
		);
	});
});

describe("defaultPluginLoader — override hook", () => {
	afterEach(clearOverride);

	test("prefers __pluginLoaderOverride when installed", async () => {
		const overridePlugin: Plugin = {
			name: "override",
			worker: () => ({ exports: { overridden: true } }),
		};
		const override: ModuleLoader = (d) => {
			expect(d.name).toBe("override");
			return overridePlugin;
		};
		(
			globalThis as { __pluginLoaderOverride?: ModuleLoader }
		).__pluginLoaderOverride = override;
		const descriptor: PluginDescriptor = {
			name: "override",
			// Bogus source — the override path must NOT evaluate it.
			workerSource: "this is not valid JavaScript @@@",
		};
		const plugin = await defaultPluginLoader(descriptor);
		expect(plugin).toBe(overridePlugin);
	});
});

describe("loadPluginFromSource", () => {
	test("is a pure helper — bypasses the override hook", async () => {
		(
			globalThis as { __pluginLoaderOverride?: ModuleLoader }
		).__pluginLoaderOverride = () => {
			throw new Error("override must not be consulted");
		};
		try {
			const plugin = await loadPluginFromSource({
				name: "pure",
				workerSource: "export default () => ({ ok: true });",
			});
			expect(plugin.name).toBe("pure");
		} finally {
			clearOverride();
		}
	});
});
