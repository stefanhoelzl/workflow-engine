import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineConfig } from "vite";

const workflowEntries = Object.fromEntries(
	readdirSync(import.meta.dirname)
		.filter((f) => f.endsWith(".ts") && !f.includes("config"))
		.map((f) => [basename(f, ".ts"), resolve(import.meta.dirname, f)]),
);

// biome-ignore lint/style/noDefaultExport: required by Vite
export default defineConfig({
	build: {
		lib: {
			entry: workflowEntries,
			formats: ["es"],
		},
		outDir: "dist",
	},
	ssr: {
		target: "node",
		noExternal: true,
	},
});
