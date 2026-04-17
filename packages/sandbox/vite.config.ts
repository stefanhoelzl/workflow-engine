// Sandbox vite build — compiles src/worker.ts into dist/src/worker.js with
// the sandbox polyfills virtual module resolved into an IIFE string.
//
// Worker is loaded at runtime via
//   `new Worker(pathToFileURL(dist/src/worker.js))` (see src/index.ts:
//   resolveWorkerUrl()). Node's native ESM loader processes the file
//   and cannot resolve virtual: schemes, so the polyfill IIFE MUST be
//   inlined at build time. This config makes vite the authoritative
//   emitter for worker.js (tsc's emit of worker.js is overwritten).
//
// All other sandbox source files (index.ts, bridge.ts, globals.ts, etc.)
// are published as raw TS via `exports: { ".": "./src/index.ts" }` and
// bundled by the consuming runtime's vite build — only worker.js needs
// its own build because it's filesystem-loaded, not imported.

import { defineConfig } from "vite";
import { sandboxPolyfills } from "./src/polyfills/vite-plugin.js";

export default defineConfig({
	plugins: [sandboxPolyfills()],
	build: {
		ssr: "src/worker.ts",
		outDir: "dist/src",
		emptyOutDir: false, // don't wipe tsc's other outputs (index.js, etc.)
		target: "esnext",
		rollupOptions: {
			output: {
				entryFileNames: "worker.js",
				chunkFileNames: "worker.[hash].js",
				format: "esm",
			},
		},
	},
	ssr: {
		target: "node",
		noExternal: true,
		external: [
			"quickjs-wasi",
			"quickjs-wasi/base64",
			"quickjs-wasi/crypto",
			"quickjs-wasi/encoding",
			"quickjs-wasi/headers",
			"quickjs-wasi/structured-clone",
			"quickjs-wasi/url",
			"@workflow-engine/core",
		],
	},
});
