import { sandboxPlugins } from "@workflow-engine/sandbox/vite";
import { sandboxPolyfills } from "@workflow-engine/sandbox-stdlib/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [sandboxPlugins(), sandboxPolyfills()],
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
