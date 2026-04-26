import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: resolve(import.meta.dirname),
	test: {
		name: "tests",
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		globalSetup: ["./src/global-setup.ts"],
	},
});
