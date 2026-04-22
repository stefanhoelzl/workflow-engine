// Vite plugin that resolves `<path>?sandbox-plugin` imports by rollup-
// bundling the target TS file with a synthetic entry retaining only its
// `worker` export. Standard ESM tree-shaking drops main-thread-only code
// (e.g. schema compilers imported by consumer helpers in the same file),
// yielding a self-contained ESM module string suitable for `data:` URI
// evaluation in the sandbox worker.
//
// Consumer-facing shape:
//
//   import plugin from "./plugins/host-call-action?sandbox-plugin";
//   // plugin = { name, dependsOn, source }
//   //   name / dependsOn re-import live from the original file;
//   //   source is the tree-shaken ESM bundle whose default export is
//   //   the `worker(ctx, deps, config)` function.

import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import * as commonjsMod from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import type { Plugin as RollupPlugin } from "rollup";
import { rollup } from "rollup";
import * as esbuildMod from "rollup-plugin-esbuild";
import type { Plugin } from "vite";

const esbuild = ((esbuildMod as { default?: unknown }).default ??
	esbuildMod) as (opts: Record<string, unknown>) => RollupPlugin;
const commonjs = ((commonjsMod as { default?: unknown }).default ??
	commonjsMod) as (opts?: Record<string, unknown>) => RollupPlugin;

const QUERY_SUFFIX = "?sandbox-plugin";
// Rollup/vite treat leading-null IDs as internal virtual modules, opting
// them out of further transforms by downstream plugins.
const VIRTUAL_PREFIX = "\0sandbox-plugin:";
const SYNTHETIC_ENTRY_PREFIX = "\0sandbox-plugin-entry:";

function resolveEntryPath(
	source: string,
	importer: string | undefined,
): string {
	const bare = source.slice(0, -QUERY_SUFFIX.length);
	if (bare.startsWith(".") || isAbsolute(bare)) {
		if (!importer) {
			throw new Error(
				`sandbox-plugins: relative import ${JSON.stringify(source)} has no importer to resolve against`,
			);
		}
		return resolvePath(dirname(importer), bare);
	}
	// Bare package specifier — resolve through the importer's node_modules.
	const require = createRequire(importer ?? `${process.cwd()}/noop.js`);
	return require.resolve(bare);
}

async function bundleWorkerExport(entry: string): Promise<string> {
	const syntheticId = `${SYNTHETIC_ENTRY_PREFIX}${entry}`;
	const bundle = await rollup({
		input: syntheticId,
		plugins: [
			{
				name: "sandbox-plugin-synthetic-entry",
				resolveId(src) {
					if (src === syntheticId) {
						return src;
					}
					return;
				},
				load(loadId) {
					if (loadId !== syntheticId) {
						return;
					}
					// The only export reachable from this entry is `worker`.
					// Everything else in the plugin file — including main-thread-
					// only imports like Ajv that the consumer uses via separate
					// helpers — is tree-shaken away by rollup.
					return `export { worker as default } from ${JSON.stringify(entry)};`;
				},
			},
			esbuild({ target: "es2022", tsconfig: false }),
			nodeResolve({ preferBuiltins: true }),
			commonjs(),
		],
		treeshake: true,
		external: (id) => {
			// Node builtins — not bundled; the worker eval of the bundled
			// source runs in a real Node worker_thread where builtins are
			// resolvable via bare name. Prefixed or plain.
			if (id.startsWith("node:")) {
				return true;
			}
			return false;
		},
	});
	try {
		const { output } = await bundle.generate({ format: "esm" });
		return output[0].code;
	} finally {
		await bundle.close();
	}
}

/**
 * Vite plugin: register in each consumer package's vite.config.ts so
 * `<path>?sandbox-plugin` imports produce `{ name, dependsOn?, source }`
 * records consumable by `PluginDescriptor` composition.
 */
export function sandboxPlugins(): Plugin {
	return {
		name: "sandbox-plugins",
		enforce: "pre",
		resolveId(source, importer) {
			if (!source.endsWith(QUERY_SUFFIX)) {
				return;
			}
			const entry = resolveEntryPath(source, importer);
			return `${VIRTUAL_PREFIX}${entry}`;
		},
		async load(id) {
			if (!id.startsWith(VIRTUAL_PREFIX)) {
				return;
			}
			const entry = id.slice(VIRTUAL_PREFIX.length);
			const workerSource = await bundleWorkerExport(entry);

			// Re-import `name` / `dependsOn` as live bindings from the original
			// file so consumer code gets accurate TS types (the original module's
			// `export const name = "..."` flows through unchanged). A namespace
			// import sidesteps the "module does not export X" error when a
			// plugin omits `dependsOn`.
			return `
import * as mod from ${JSON.stringify(entry)};
export const name = mod.name;
export const dependsOn = mod.dependsOn;
export const source = ${JSON.stringify(workerSource)};
export default { name, dependsOn, source };
`;
		},
	};
}
