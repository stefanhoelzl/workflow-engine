import { sandboxPlugins } from "@workflow-engine/sandbox/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [sandboxPlugins()],
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
