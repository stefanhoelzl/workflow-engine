// Vite plugin that resolves `<path>?sandbox-plugin` imports by running two
// independent rollup builds against the target TS file:
//
//   1. Worker pass (always): synthetic entry `export { worker as default }
//      from <path>`; output format esm; treeshake.moduleSideEffects=false so
//      guest-only top-level imports (which lack a reachable reference from
//      `worker`) get dropped rather than conservatively preserved. Node
//      builtins (`node:*`) stay external — the worker ESM is loaded inside
//      a Node worker_thread via `data:text/javascript;base64,...` dynamic
//      import, which resolves `node:*` natively.
//
//   2. Guest pass (only when the plugin file exports a `guest` function):
//      synthetic entry `import { guest } from <path>; guest();`; output
//      format iife; default treeshake (module side effects preserved so
//      polyfill packages' module-level initialization is not dropped).
//      NO `node:*` external — a guest-side `node:fs` import MUST fail the
//      bundle. The guest IIFE is evaluated as top-level script inside
//      QuickJS at plugin Phase 2 (see SECURITY.md §2 R-1 / R-5).
//
// Consumer-facing shape:
//
//   import plugin from "./plugins/host-call-action?sandbox-plugin";
//   // plugin = { name, dependsOn?, workerSource, guestSource? }
//   //   name / dependsOn re-import live from the original file;
//   //   workerSource is the tree-shaken ESM bundle whose default export is
//   //     the `worker(ctx, deps, config)` function;
//   //   guestSource (present only when the file exports `guest`) is the
//   //     IIFE that invokes `guest()` at its end.

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
const WORKER_SYNTHETIC_PREFIX = "\0sandbox-plugin-worker-entry:";
const GUEST_SYNTHETIC_PREFIX = "\0sandbox-plugin-guest-entry:";

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
	const syntheticId = `${WORKER_SYNTHETIC_PREFIX}${entry}`;
	const bundle = await rollup({
		input: syntheticId,
		plugins: [
			{
				name: "sandbox-plugin-worker-synthetic-entry",
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
					// Only `worker` reaches the output. Everything else in the plugin
					// file — including a `guest()` function and its guest-only
					// imports — is dropped by the combination of reachability
					// analysis + `moduleSideEffects: false`. Without the flag, rollup
					// would preserve top-level imports from packages that don't
					// declare `"sideEffects": false` in their package.json (e.g.
					// `web-streams-polyfill`), leaking them into the worker bundle.
					return `export { worker as default } from ${JSON.stringify(entry)};`;
				},
			},
			esbuild({ target: "es2022", tsconfig: false }),
			nodeResolve({ preferBuiltins: true }),
			commonjs(),
		],
		treeshake: { moduleSideEffects: false },
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

function guestSyntheticEntryPlugin(
	entry: string,
	syntheticId: string,
): RollupPlugin {
	return {
		name: "sandbox-plugin-guest-synthetic-entry",
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
			// Call `guest()` at the top of the IIFE so rollup emits a
			// side-effect bundle rather than dead-code-eliminating the
			// function. `worker` and its imports are unreachable from this
			// entry and therefore dropped.
			return `import { guest } from ${JSON.stringify(entry)}; guest();`;
		},
	};
}

async function bundleGuestExport(entry: string): Promise<string> {
	const syntheticId = `${GUEST_SYNTHETIC_PREFIX}${entry}`;
	const bundle = await rollup({
		input: syntheticId,
		plugins: [
			guestSyntheticEntryPlugin(entry, syntheticId),
			esbuild({ target: "es2022", tsconfig: false }),
			nodeResolve(),
			commonjs(),
		],
		// `node:*` marked external so resolveId doesn't fail on them;
		// unreachable-from-`guest()` ones get DCE'd via `"no-external"`,
		// reachable ones are caught post-bundle.
		external: (id) => id.startsWith("node:"),
		// External modules (node:*) are side-effect-free so unused
		// imports get DCE'd; all INTERNAL modules (plugin file + its
		// transitive imports, incl. polyfill packages) keep default
		// side-effect-true behavior so their module-level initialization
		// survives.
		treeshake: { moduleSideEffects: "no-external" },
	});
	try {
		const { output } = await bundle.generate({
			format: "iife",
			name: "__sandboxPluginGuest",
			globals: (id) =>
				id.startsWith("node:") ? id.replace(/[^a-zA-Z0-9]/g, "_") : id,
		});
		const chunk = output[0];
		const leakedNodeImports = chunk.imports.filter((id) =>
			id.startsWith("node:"),
		);
		if (leakedNodeImports.length > 0) {
			throw new Error(
				`sandbox-plugin guest bundle cannot depend on ${JSON.stringify(
					leakedNodeImports,
				)} — guest code runs in QuickJS and has no Node.js surface`,
			);
		}
		return chunk.code;
	} finally {
		await bundle.close();
	}
}

// Rollup error message when the guest synthetic entry imports a name the
// target module does not export. Detected to gracefully omit `guestSource`
// for plugins that only export `worker`. Rollup's message shape varies
// across versions ("is not exported by" / "does not provide an export
// named ..."); match both.
const NO_GUEST_EXPORT_RE =
	/["']guest["'] is not exported by|does not provide an export named ["']guest["']/i;

function isNoGuestExportError(err: unknown): boolean {
	if (err === null || typeof err !== "object") {
		return false;
	}
	const msg = (err as { message?: unknown }).message;
	return typeof msg === "string" && NO_GUEST_EXPORT_RE.test(msg);
}

async function tryBundleGuestExport(
	entry: string,
): Promise<string | undefined> {
	try {
		return await bundleGuestExport(entry);
	} catch (err) {
		if (isNoGuestExportError(err)) {
			return;
		}
		throw err;
	}
}

/**
 * Vite plugin: register in each consumer package's vite.config.ts so
 * `<path>?sandbox-plugin` imports produce `{ name, dependsOn?, workerSource,
 * guestSource? }` records consumable by `PluginDescriptor` composition.
 *
 * Security discipline: the emitted `workerSource` runs inside a Node
 * worker_thread (so it has access to Node APIs); the emitted `guestSource`
 * runs inside the QuickJS guest VM (per SECURITY.md §2 R-1 / R-5, no Node
 * surface and no privileged globals should leak into it). The two rollup
 * passes keep these trees bundle-time-isolated.
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
			const [workerSource, guestSource] = await Promise.all([
				bundleWorkerExport(entry),
				tryBundleGuestExport(entry),
			]);

			// Re-import `name` / `dependsOn` as live bindings from the original
			// file so consumer code gets accurate TS types (the original module's
			// `export const name = "..."` flows through unchanged). A namespace
			// import sidesteps the "module does not export X" error when a
			// plugin omits `dependsOn`.
			const guestExport =
				guestSource === undefined
					? ""
					: `export const guestSource = ${JSON.stringify(guestSource)};\n`;
			const guestDefault = guestSource === undefined ? "" : ", guestSource";
			return `
import * as mod from ${JSON.stringify(entry)};
export const name = mod.name;
export const dependsOn = mod.dependsOn;
export const workerSource = ${JSON.stringify(workerSource)};
${guestExport}export default { name, dependsOn, workerSource${guestDefault} };
`;
		},
	};
}
