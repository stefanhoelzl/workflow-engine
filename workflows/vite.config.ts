import { defineConfig } from "vite";
import { workflowPlugin } from "@workflow-engine/vite-plugin";

export default defineConfig({
	plugins: [
		workflowPlugin({
			workflows: ["./cronitor.ts"],
		}),
	],
});
