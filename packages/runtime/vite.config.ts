import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sandboxPlugins } from "@workflow-engine/sandbox/vite";
import { defineConfig, type Plugin } from "vite";

// The sandbox spawns its worker via `new Worker(url)` against an on-disk file
// (worker.ts → dist/src/worker.js, built by packages/sandbox/vite.config.ts).
// The runtime's SSR bundle inlines sandbox source via `noExternal: true`, so
// `import.meta.url` inside sandbox.ts post-bundle points at the runtime's
// dist/main.js — not at sandbox's dist. To keep `node dist/main.js` runnable
// directly (e.g. e2e spawn), we copy the sandbox's worker.js next to the
// bundled main.js. `resolveWorkerUrl` in sandbox.ts prefers that sibling
// when present and falls back to the source-tree layout for vite-node dev.
function copySandboxWorker(): Plugin {
	const src = fileURLToPath(
		new URL("../sandbox/dist/src/worker.js", import.meta.url),
	);
	const dst = fileURLToPath(new URL("./dist/worker.js", import.meta.url));
	return {
		name: "copy-sandbox-worker",
		async closeBundle() {
			await copyFile(src, dst);
		},
	};
}

export default defineConfig({
	plugins: [sandboxPlugins(), copySandboxWorker()],
	build: {
		ssr: "src/main.ts",
		outDir: "dist",
	},
	ssr: {
		target: "node",
		noExternal: true,
		external: ["@duckdb/node-bindings", "@jitl/quickjs-wasmfile-release-sync"],
	},
	server: {
		watch: {
			ignored: ["**/node_modules/**", "**/dist/**"],
		},
	},
});
