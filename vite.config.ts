import { defineConfig } from "vite";

// biome-ignore lint/style/noDefaultExport: required by Vite
export default defineConfig({
	build: {
		ssr: "packages/runtime/src/main.ts",
		outDir: "dist",
	},
	ssr: {
		target: "node",
		noExternal: true,
	},
});
