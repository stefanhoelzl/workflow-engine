// Vite plugin that resolves `virtual:wpt-preamble` by rollup-bundling
// preamble.ts / post-harness.ts / entry.ts — each into an IIFE string —
// and emitting an ES module exporting the three as named string
// constants. composer.ts consumes the three IIFEs and concatenates them
// with testharness.js + test file source into the per-test sandbox eval.
//
// Unlike the sandbox polyfill plugin, this runs purely at vitest load
// time: the composer is test-time code (processed by vitest's vite),
// not a Node-worker file pre-compiled to disk. No separate build step.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { type Plugin as RollupPlugin, rollup } from "rollup";
import * as esbuildMod from "rollup-plugin-esbuild";
import type { Plugin } from "vite";

const esbuild = ((esbuildMod as { default?: unknown }).default ??
	esbuildMod) as (opts: Record<string, unknown>) => RollupPlugin;

const VIRTUAL_ID = "virtual:wpt-preamble";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

async function bundleToIife(entry: string): Promise<string> {
	const bundle = await rollup({
		input: entry,
		plugins: [esbuild({ target: "es2022", tsconfig: false }), nodeResolve()],
	});
	try {
		const { output } = await bundle.generate({
			format: "iife",
			name: "__wptPreambleChunk",
		});
		return output[0].code;
	} finally {
		await bundle.close();
	}
}

export function wptPreamble(): Plugin {
	return {
		name: "wpt-preamble",
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
			const here = dirname(fileURLToPath(import.meta.url));
			const [preamble, postHarness, entry] = await Promise.all([
				bundleToIife(resolve(here, "preamble.ts")),
				bundleToIife(resolve(here, "post-harness.ts")),
				bundleToIife(resolve(here, "entry.ts")),
			]);
			return [
				`export const PREAMBLE = ${JSON.stringify(preamble)};`,
				`export const POST_HARNESS = ${JSON.stringify(postHarness)};`,
				`export const ENTRY = ${JSON.stringify(entry)};`,
			].join("\n");
		},
	};
}
