import { workflowPlugin } from "@workflow-engine/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		workflowPlugin({
			workflows: ["./cronitor.ts"],
		}),
	],
});
