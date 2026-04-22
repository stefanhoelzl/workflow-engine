// Sandbox vite build — compiles src/worker.ts into dist/src/worker.js.
//
// Worker is loaded at runtime via
//   `new Worker(pathToFileURL(dist/src/worker.js))` (see src/index.ts:
//   resolveWorkerUrl()). Node's native ESM loader processes the file
//   directly. The polyfill IIFE (`virtual:sandbox-polyfills`) is now
//   resolved at the runtime's vite build (via `@workflow-engine/sandbox
//   -stdlib/vite`) and passed into the web-platform plugin descriptor's
//   `bundleSource` config — the sandbox worker itself no longer imports
//   the virtual module directly.
//
// All other sandbox source files (index.ts, bridge.ts, globals.ts, etc.)
// are published as raw TS via `exports: { ".": "./src/index.ts" }` and
// bundled by the consuming runtime's vite build — only worker.js needs
// its own build because it's filesystem-loaded, not imported.

import { defineConfig } from "vite";

export default defineConfig({
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
