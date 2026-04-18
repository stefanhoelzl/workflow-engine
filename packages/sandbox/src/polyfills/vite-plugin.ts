// Vite plugin that resolves `virtual:sandbox-polyfills` by rollup-bundling
// packages/sandbox/src/polyfills/entry.ts into a single IIFE string.
// worker.ts imports this string and vm.evalCode()s it inside QuickJS.
//
// Register in `packages/sandbox/vite.config.ts` — the sandbox's own vite
// build compiles worker.ts into dist/src/worker.js with the virtual module
// inlined as a string constant, producing a bundle that Node's native ESM
// loader (used by new Worker(pathToFileURL(...))) can load directly.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import * as replaceMod from "@rollup/plugin-replace";
import { type Plugin as RollupPlugin, rollup } from "rollup";
import * as esbuildMod from "rollup-plugin-esbuild";
import type { Plugin } from "vite";

const replace = ((replaceMod as { default?: unknown }).default ??
	replaceMod) as (opts: Record<string, unknown>) => RollupPlugin;
const esbuild = ((esbuildMod as { default?: unknown }).default ??
	esbuildMod) as (opts: Record<string, unknown>) => RollupPlugin;

const VIRTUAL_ID = "virtual:sandbox-polyfills";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

// fetch-blob v4's index.js has a top-level `if (!globalThis.ReadableStream)
// { await import('node:process'); ... }` Node fallback. Rollup's IIFE
// format rejects top-level await even when the branch is dead at runtime.
// Strip the block — streams.ts installs ReadableStream before blob.ts loads.
// (No-op for fetch-blob v3 pulled in transitively by formdata-polyfill;
// v3 has no TLA, so a downstream TLA-detection failure remains the signal
// if a future fetch-blob version changes shape.)
const FETCH_BLOB_TLA_RE =
	/^if \(!globalThis\.ReadableStream\) \{[\s\S]*?^\}\n/m;

function stripFetchBlobTLA(): RollupPlugin {
	return {
		name: "strip-fetch-blob-tla",
		transform(code, id) {
			if (!id.endsWith("/fetch-blob/index.js")) {
				return;
			}
			const stripped = code.replace(
				FETCH_BLOB_TLA_RE,
				"// fetch-blob TLA Node fallback removed — streams.ts polyfill provides ReadableStream\n",
			);
			return stripped === code ? undefined : { code: stripped, map: null };
		},
	};
}

function readSandboxVersion(): string {
	const pkgPath = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"package.json",
	);
	const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
		version?: string;
	};
	if (!parsed.version) {
		throw new Error(
			"sandbox-polyfills: could not read version from package.json",
		);
	}
	return parsed.version;
}

export function sandboxPolyfills(): Plugin {
	return {
		name: "sandbox-polyfills",
		resolveId(id) {
			if (id === VIRTUAL_ID) {
				return RESOLVED_ID;
			}
			return;
		},
		async load(id) {
			if (id !== RESOLVED_ID) {
				return;
			}
			const entry = resolve(
				dirname(fileURLToPath(import.meta.url)),
				"entry.ts",
			);
			const version = readSandboxVersion();
			const bundle = await rollup({
				input: entry,
				plugins: [
					replace({
						values: { __WFE_VERSION__: JSON.stringify(version) },
						preventAssignment: true,
					}),
					stripFetchBlobTLA(),
					esbuild({ target: "es2022", tsconfig: false }),
					nodeResolve(),
				],
			});
			try {
				const { output } = await bundle.generate({
					format: "iife",
					name: "__sandboxPolyfills",
				});
				return `export default ${JSON.stringify(output[0].code)};`;
			} finally {
				await bundle.close();
			}
		},
	};
}
