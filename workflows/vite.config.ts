import { defineConfig } from "vite";
import { workflowPlugin } from "@workflow-engine/vite-plugin";

// biome-ignore lint/style/noDefaultExport: required by Vite
export default defineConfig({
	plugins: [
		workflowPlugin({
			workflows: ["./cronitor.ts"],
		}),
	],
});
