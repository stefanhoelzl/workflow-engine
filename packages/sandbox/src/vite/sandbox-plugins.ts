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

import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import * as commonjsMod from "@rollup/plugin-commonjs";
import * as jsonMod from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import type { Plugin as RollupPlugin } from "rollup";
import { rollup } from "rollup";
import * as esbuildMod from "rollup-plugin-esbuild";
import type { Plugin } from "vite";

const BUILTIN_MODULES = new Set(builtinModules);

// JSON file matcher for @rollup/plugin-json — hoisted so the regex literal is
// shared across the worker + guest passes rather than re-created per call.
const JSON_FILE_RE = /\.json$/;

// Guest-bundle side-effect marker. Modules matching WEB_PLATFORM_SIDE_EFFECTS_RE
// or one of the SELF_INSTALLING_POLYFILLS are preserved by rollup's tree-shake
// even when their exports are unused; every other internal module is
// considered side-effect-free so the worker-only chain (mail/worker.ts →
// nodemailer) gets DCE'd from the guest IIFE.
const WEB_PLATFORM_SIDE_EFFECTS_RE =
	/[\\/]sandbox-stdlib[\\/]src[\\/]web-platform[\\/]/;
const SELF_INSTALLING_POLYFILLS_RE =
	/[\\/]node_modules[\\/](?:urlpattern-polyfill|scheduler-polyfill|core-js)[\\/]/;

const esbuild = ((esbuildMod as { default?: unknown }).default ??
	esbuildMod) as (opts: Record<string, unknown>) => RollupPlugin;
const commonjs = ((commonjsMod as { default?: unknown }).default ??
	commonjsMod) as (opts?: Record<string, unknown>) => RollupPlugin;
const json = ((jsonMod as { default?: unknown }).default ?? jsonMod) as (
	opts?: Record<string, unknown>,
) => RollupPlugin;

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
			// JSON transform for CJS `require('./foo.json')` inside bundled
			// deps (e.g. nodemailer's `require('../../package.json')` for
			// version strings). Regex-form `include` matches .json files at
			// ANY absolute path (the glob-form `**/*.json` is base-resolved
			// against cwd and misses node_modules in nested workspaces).
			json({ include: [JSON_FILE_RE] }),
			nodeResolve({ preferBuiltins: true }),
			commonjs(),
		],
		treeshake: { moduleSideEffects: false },
		external: (id) => {
			// Node builtins — not bundled; the worker eval of the bundled
			// source runs in a real Node worker_thread where builtins are
			// resolvable via bare name. Both prefixed and plain forms (CJS
			// deps like nodemailer do `require('events')` / `require('stream')`
			// without the `node:` prefix).
			if (id.startsWith("node:")) {
				return true;
			}
			return BUILTIN_MODULES.has(id);
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

// CONTRACT — guest-bundle tree-shake allowlist.
//
// Internal modules default to side-effect-free (aggressive DCE) so worker-
// only chains like `mail/worker.ts → nodemailer` don't leak into the QuickJS
// IIFE. Two path patterns are explicitly preserved as side-effectful:
//   • web-platform/**            — guest polyfill chain (entry.ts et al)
//   • urlpattern-polyfill        — self-installs via its package index
//   • scheduler-polyfill         — self-installs via its package index
//   • core-js                    — feature-detected ES polyfills; each
//                                  `core-js/stable/<feature>` import is a
//                                  pure side-effect that mutates intrinsics
//
// Regression check: `pnpm test:wpt` loads `webPlatformPlugin.guestSource`
// into a real QuickJS sandbox via the same `?sandbox-plugin` pipeline used
// in production and exercises URLPattern, URL, EventTarget, fetch,
// scheduler, etc. Breaking either regex above WILL fail WPT.
//   ⚠ WPT is NOT part of `pnpm validate` — run `pnpm test:wpt` explicitly
//   before changing this allowlist.
//
// FORWARD CASE — adding a NEW sandbox-stdlib plugin: if your plugin's entry
// chain depends on bare side-effect imports (`import "./install-foo.js"`)
// that are NOT under web-platform/ and NOT one of the two npm polyfills
// above, you MUST add a matching path here. Otherwise rollup DCE's the
// import and the polyfill never runs in QuickJS — the symptom is "X is not
// defined" at guest source-eval, with no build/lint signal.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the rollup config is a single cohesive tree-shake policy; splitting would scatter unrelated hooks across helpers and obscure the bundle contract
async function bundleGuestExport(entry: string): Promise<string> {
	const syntheticId = `${GUEST_SYNTHETIC_PREFIX}${entry}`;
	const bundle = await rollup({
		input: syntheticId,
		plugins: [
			guestSyntheticEntryPlugin(entry, syntheticId),
			esbuild({ target: "es2022", tsconfig: false }),
			// JSON transform for any .json reached during parse walking (e.g.
			// `require('../../package.json')` inside worker-side deps that
			// are re-exported from the plugin file's index.ts). Although the
			// treeshake drops these chains, rollup still parses them to
			// resolve `export { x } from "./worker.js"` chains.
			json({ include: [JSON_FILE_RE] }),
			nodeResolve(),
			commonjs(),
		],
		// `node:*` marked external so resolveId doesn't fail on them;
		// post-bundle check rejects any `node:*` that actually survived
		// into the guest bundle.
		external: (id) => id.startsWith("node:"),
		// Guest bundles must NOT drag in worker-only transitive modules
		// (e.g. `nodemailer` reached via `export { worker } from
		// "./worker.js"`). With a blanket side-effect-true default, rollup
		// walks every internal re-export even when no downstream consumer
		// imports the re-exported binding — so the whole nodemailer tree
		// lands in the guest IIFE and crashes at source-eval (`events is
		// not defined` etc.).
		//
		// Fix: default internal modules to side-effect-free (aggressive
		// DCE) and explicitly preserve the paths that self-install at
		// module-load time via bare `import "…"` side-effect imports:
		//   • web-platform/**          — guest polyfill chain (entry.ts et al)
		//   • urlpattern-polyfill      — self-installs via its package index
		//   • scheduler-polyfill       — self-installs via its package index
		treeshake: {
			moduleSideEffects: (id, external) => {
				if (external) {
					return false;
				}
				if (WEB_PLATFORM_SIDE_EFFECTS_RE.test(id)) {
					return true;
				}
				if (SELF_INSTALLING_POLYFILLS_RE.test(id)) {
					return true;
				}
				return false;
			},
		},
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

const META_SYNTHETIC_PREFIX = "\0sandbox-plugin-meta-entry:";
const META_STUB_PREFIX = "\0sandbox-plugin-meta-stub:";

// Resolve `name` and `dependsOn` values from the plugin's TS entry file at
// bundle time, returning them as static literals. This lets the virtual
// `?sandbox-plugin` module be self-contained so the outer consumer bundle
// does NOT walk the plugin's transitive imports (avoiding the need to
// bundle heavy node-only deps like nodemailer in the outer build).
//
// Strategy: run a side-effect-free rollup pass that treeshakes to just
// `name` and `dependsOn`. Any node_modules or workspace package import is
// replaced by an empty stub — the plugin file references their IDENTIFIERS
// inside `worker()` / closure code which gets DCE'd, so the stubs never
// need real content to satisfy tree-shake. Transitive local TS files
// (like a sibling `worker.ts`) are resolved normally and tree-shaken.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the stubbing resolveId + load + post-bundle import-and-validate form a single cohesive meta-extraction pass; splitting would require threading the bundle handle across helpers
async function extractPluginMetadata(
	entry: string,
): Promise<{ name: string; dependsOn: readonly string[] | undefined }> {
	const syntheticId = `${META_SYNTHETIC_PREFIX}${entry}`;
	const bundle = await rollup({
		input: syntheticId,
		plugins: [
			{
				name: "sandbox-plugin-meta-synthetic-entry",
				resolveId(src, importer) {
					if (src === syntheticId) {
						return src;
					}
					if (src.startsWith(META_STUB_PREFIX)) {
						return src;
					}
					// Bare specifiers from user-authored TS (plugin file or its
					// local transitive imports) → stub, EXCEPT for workspace
					// packages (`@workflow-engine/*`), which are resolved
					// normally via nodeResolve so that re-exported identifiers
					// used in `name` / `dependsOn` (e.g. `WASI_PLUGIN_NAME`
					// from `@workflow-engine/sandbox`) evaluate to their real
					// values. Relative paths fall through to nodeResolve for
					// local .ts resolution.
					if (importer && !src.startsWith(".") && !src.startsWith("/")) {
						if (src.startsWith("node:")) {
							return { id: src, external: true };
						}
						if (src.startsWith("@workflow-engine/")) {
							return;
						}
						return `${META_STUB_PREFIX}${src}`;
					}
					return;
				},
				load(loadId) {
					if (loadId === syntheticId) {
						return `import * as mod from ${JSON.stringify(entry)};\nexport const name = mod.name;\nexport const dependsOn = mod.dependsOn;`;
					}
					if (loadId.startsWith(META_STUB_PREFIX)) {
						// Stubbed module: any named import from it resolves
						// via `syntheticNamedExports` to a property of the
						// default (empty) object, yielding undefined. The
						// plugin file's worker body — the only code actually
						// using those imports — is DCE'd by
						// `moduleSideEffects: false`, so no runtime access
						// ever happens. This lets the meta extraction bundle
						// the plugin file's `name` / `dependsOn` without
						// walking heavy transitive deps (nodemailer, etc.).
						return {
							code: "export default {};",
							syntheticNamedExports: "default",
						};
					}
					return;
				},
			},
			esbuild({ target: "es2022", tsconfig: false }),
			nodeResolve({ preferBuiltins: true, extensions: [".mjs", ".js", ".ts"] }),
		],
		treeshake: { moduleSideEffects: false },
		external: (id) => id.startsWith("node:"),
		onwarn: () => {
			/* suppress unresolved import warnings during meta extraction */
		},
	});
	try {
		const { output } = await bundle.generate({ format: "esm" });
		const code = output[0].code;
		const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
		const mod: { name?: unknown; dependsOn?: unknown } = await import(url);
		if (typeof mod.name !== "string") {
			throw new Error(
				`sandbox-plugins: ${entry} does not export a string \`name\``,
			);
		}
		const dependsOn = Array.isArray(mod.dependsOn)
			? (mod.dependsOn as string[])
			: undefined;
		return { name: mod.name, dependsOn };
	} finally {
		await bundle.close();
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
			const [workerSource, guestSource, metadata] = await Promise.all([
				bundleWorkerExport(entry),
				tryBundleGuestExport(entry),
				extractPluginMetadata(entry),
			]);

			// Emit static `name` / `dependsOn` values extracted at build time.
			// Do NOT import the entry file from this virtual module — that
			// would pull the plugin's transitive imports (e.g. nodemailer in
			// the mail plugin) into the outer consumer bundle even though
			// workerSource is an inert string.
			const guestExport =
				guestSource === undefined
					? ""
					: `export const guestSource = ${JSON.stringify(guestSource)};\n`;
			const guestDefault = guestSource === undefined ? "" : ", guestSource";
			const dependsOnLiteral =
				metadata.dependsOn === undefined
					? "undefined"
					: JSON.stringify(metadata.dependsOn);
			return `
export const name = ${JSON.stringify(metadata.name)};
export const dependsOn = ${dependsOnLiteral};
export const workerSource = ${JSON.stringify(workerSource)};
${guestExport}export default { name, dependsOn, workerSource${guestDefault} };
`;
		},
	};
}
