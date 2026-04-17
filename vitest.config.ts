import { defineConfig } from "vitest/config";
import { wptPreamble } from "./packages/sandbox/test/wpt/harness/preamble/vite-plugin.js";

export default defineConfig({
	plugins: [wptPreamble()],
	test: {
		include: [
			"packages/*/src/**/*.{test,spec}.ts",
			// Harness unit tests that verify the WPT runner's match/specificity/
			// limited-all helpers. Fast and deterministic, safe to run in the
			// default pnpm test. The heavy WPT suite itself (wpt.test.ts) is
			// excluded below and runs only via pnpm test:wpt.
			"packages/sandbox/test/wpt/harness/**/*.{test,spec}.ts",
		],
		exclude: ["**/node_modules/**", "packages/sandbox/test/wpt/wpt.test.ts"],
	},
});
